import { describe, expect, it } from 'vitest';

import {
  adjustmentsFor,
  daysApart,
  explain,
  explainWith,
  numberKey,
  numberParts,
  numbersAlike,
  parse2bJson,
  parse2bTable,
  reconcile,
  summarise,
  toIsoDate,
  toPaise,
  toPeriod,
  type BookBill,
  type Entry2B,
  type Match,
} from '../src';

const G1 = '29AABCU9603R1ZJ';
const G2 = '27AAPFU0939F1ZV';

let n = 0;
const entry = (o: Partial<Entry2B> = {}): Entry2B => ({
  id: `e${++n}`,
  supplierGstin: G1,
  supplierName: 'Supplier',
  docType: 'invoice',
  number: 'INV/001',
  date: '2025-04-10',
  taxable: 100_000,
  igst: 0,
  cgst: 9_000,
  sgst: 9_000,
  cess: 0,
  itcAvailable: 'Y',
  reason: '',
  supplierPeriod: '042025',
  period: '042025',
  ...o,
});
const bill = (o: Partial<BookBill> = {}): BookBill => ({
  id: `b${++n}`,
  supplierGstin: G1,
  number: 'INV/001',
  date: '2025-04-10',
  type: 'purchase_bill',
  taxable: 100_000,
  igst: 0,
  cgst: 9_000,
  sgst: 9_000,
  cess: 0,
  ...o,
});

describe('number normalisation (variations seen in real purchase books)', () => {
  it.each([
    ['INV/0012', 'INV12'],
    ['inv-12', 'INV12'],
    ['INV 12', 'INV12'],
    ['0012', '12'],
    ['0', '0'],
    ['00', '0'],
    ['A/00/01', 'A01'],
    ['GST/2025-26/00045', 'GST20252645'],
    ['GST/2025-26/45', 'GST20252645'],
  ])('%s is %s', (raw, key) => {
    expect(numberKey(raw)).toBe(key);
  });

  it('splits a number into a prefix and the last run of digits', () => {
    expect(numberParts('INV/0012')).toEqual({ prefix: 'INV', tail: '12' });
    expect(numberParts('2025-26/INV/12')).toEqual({ prefix: '202526INV', tail: '12' });
    expect(numberParts('ABC')).toEqual({ prefix: 'ABC', tail: '' });
  });

  it.each([
    ['INV/0012', 'inv-12'],
    ['2025-26/INV/12', 'INV12'],
    ['INV12', '12'],
    ['SB/12', 'AB/SB/12'],
    ['12/A', '12'],
  ])('%s and %s can be the same document', (a, b) => {
    expect(numbersAlike(a, b)).toBe(true);
  });

  it.each([
    ['INV12', 'INV120'],
    ['12', '21'],
    ['INV12', 'BILL13'],
    ['ABC', 'XYZ'],
    ['A12', 'B12'],
  ])('%s and %s are not the same document', (a, b) => {
    expect(numbersAlike(a, b)).toBe(false);
  });

  it('counts days between dates', () => {
    expect(daysApart('2025-04-10', '2025-04-13')).toBe(3);
    expect(daysApart('2025-04-13', '2025-04-10')).toBe(-3);
    expect(daysApart('2025-02-28', '2025-03-01')).toBe(1);
  });
});

describe('matching', () => {
  it('matches the same document exactly, even when the number is written with other zeros or case', () => {
    const [m] = reconcile([entry({ number: 'inv/0001' })], [bill({ number: 'INV-1' })]);
    expect(m).toMatchObject({ cls: 'matched', diffs: [], fuzzy: false });
  });

  it('accepts a few days of date difference as an exact match', () => {
    const [m] = reconcile([entry({ date: '2025-04-12' })], [bill()]);
    expect(m!.cls).toBe('matched');
  });

  it('says which fields differ, and by how much', () => {
    const [m] = reconcile(
      [entry({ taxable: 100_000, cgst: 9_000, sgst: 9_000 })],
      [bill({ taxable: 120_000, cgst: 10_800, sgst: 10_800 })],
    );
    expect(m!.cls).toBe('matched_with_differences');
    expect(m!.diffs).toEqual(['taxable', 'cgst', 'sgst']);
    expect(m!.delta).toMatchObject({ taxable: -20_000, cgst: -1_800, sgst: -1_800 });
  });

  it('forgives a rounding difference under the tolerance and not one above it', () => {
    expect(reconcile([entry({ taxable: 100_000 })], [bill({ taxable: 100_050 })])[0]!.cls).toBe(
      'matched',
    );
    // 0.5% of INR 1,002 is about INR 5; INR 30 is well over
    expect(
      reconcile([entry({ taxable: 100_000 })], [bill({ taxable: 103_000 })])[0]!.diffs,
    ).toContain('taxable');
    expect(
      reconcile([entry({ taxable: 100_000 })], [bill({ taxable: 100_400 })], {
        amountToleranceBp: 0,
        amountTolerancePaise: 500,
      })[0]!.cls,
    ).toBe('matched');
  });

  it('matches by the looser rules when the number was written differently, and says so', () => {
    const [m] = reconcile([entry({ number: '2025-26/INV/12' })], [bill({ number: 'INV12' })]);
    expect(m).toMatchObject({ cls: 'matched_with_differences', fuzzy: true });
    expect(m!.diffs).toEqual(['number']);
  });

  it('matches the same number with a distant date within the window, as a difference', () => {
    const [m] = reconcile([entry({ date: '2025-05-10' })], [bill({ date: '2025-04-10' })]);
    expect(m).toMatchObject({ cls: 'matched_with_differences', fuzzy: true });
    expect(m!.diffs).toEqual(['date']);
    // beyond the window they are two different documents
    const far = reconcile([entry({ date: '2025-08-10' })], [bill({ date: '2025-04-10' })]);
    expect(far.map((x) => x.cls).sort()).toEqual(['in_2b_not_in_books', 'in_books_not_in_2b']);
  });

  it('does not match alike numbers when the amounts are far apart', () => {
    const r = reconcile(
      [entry({ number: 'X/12', taxable: 100_000 })],
      [bill({ number: '12', taxable: 900_000 })],
    );
    expect(r.map((x) => x.cls).sort()).toEqual(['in_2b_not_in_books', 'in_books_not_in_2b']);
  });

  it('keeps suppliers apart', () => {
    const r = reconcile([entry({ supplierGstin: G1 })], [bill({ supplierGstin: G2 })]);
    expect(r.map((x) => x.cls).sort()).toEqual(['in_2b_not_in_books', 'in_books_not_in_2b']);
  });

  it('finds lines on one side only', () => {
    const r = reconcile([entry({ number: 'A1' })], [bill({ number: 'B2', taxable: 500_000 })]);
    expect(r.find((x) => x.cls === 'in_2b_not_in_books')).toMatchObject({ billId: null });
    expect(r.find((x) => x.cls === 'in_books_not_in_2b')).toMatchObject({ entryId: null });
  });

  it('calls a repeated bill a duplicate and matches the first one', () => {
    const first = bill({ id: 'first', date: '2025-04-10' });
    const again = bill({ id: 'again', number: 'inv-1', date: '2025-04-11' });
    const r = reconcile([entry()], [again, first]);
    expect(r.find((x) => x.cls === 'duplicate_in_books')).toMatchObject({
      billId: 'again',
      duplicateOf: 'first',
    });
    expect(r.find((x) => x.cls === 'matched')).toMatchObject({ billId: 'first' });
  });

  it('matches a credit note with a purchase return and never with a bill', () => {
    const cn = entry({ docType: 'credit_note', number: 'CN/1' });
    expect(
      reconcile([cn], [bill({ number: 'CN/1' })])
        .map((x) => x.cls)
        .sort(),
    ).toEqual(['in_2b_not_in_books', 'in_books_not_in_2b']);
    expect(reconcile([cn], [bill({ number: 'CN/1', type: 'purchase_return' })])[0]!.cls).toBe(
      'matched',
    );
  });

  it('uses each bill once', () => {
    const r = reconcile([entry({ id: 'x1' }), entry({ id: 'x2', date: '2025-04-11' })], [bill()]);
    expect(r.filter((x) => x.cls === 'matched')).toHaveLength(1);
    expect(r.filter((x) => x.cls === 'in_2b_not_in_books')).toHaveLength(1);
  });

  it('puts every input in exactly one result', () => {
    const es = [entry({ number: 'A1' }), entry({ number: 'B2' }), entry({ number: 'C3' })];
    const bs = [bill({ number: 'A1' }), bill({ number: 'D4' })];
    const r = reconcile(es, bs);
    const entriesSeen = r.flatMap((x) => (x.entryId ? [x.entryId] : []));
    const billsSeen = r.flatMap((x) => (x.billId ? [x.billId] : []));
    expect(new Set(entriesSeen)).toEqual(new Set(es.map((e) => e.id)));
    expect(new Set(billsSeen)).toEqual(new Set(bs.map((b) => b.id)));
    expect(entriesSeen).toHaveLength(es.length);
    expect(billsSeen).toHaveLength(bs.length);
  });

  it('gives the same answer for the same input in any order', () => {
    const es = Array.from({ length: 40 }, (_, i) =>
      entry({
        id: `ee${i}`,
        number: `INV/${i % 25}`,
        date: `2025-04-${String((i % 27) + 1).padStart(2, '0')}`,
      }),
    );
    const bs = Array.from({ length: 40 }, (_, i) =>
      bill({
        id: `bb${i}`,
        number: `inv${(i * 7) % 25}`,
        date: `2025-04-${String(((i * 3) % 27) + 1).padStart(2, '0')}`,
      }),
    );
    const sig = (r: Match[]) =>
      r.map((x) => `${x.cls}|${x.entryId}|${x.billId}|${x.diffs.join(',')}`).join('\n');
    const a = reconcile(es, bs);
    const b = reconcile([...es].reverse(), [...bs].reverse());
    expect(sig(b)).toBe(sig(a));
  });

  it('matches 5,000 lines against 5,000 bills in under 5 seconds', () => {
    const es: Entry2B[] = [];
    const bs: BookBill[] = [];
    for (let i = 0; i < 5000; i++) {
      const sup = `${String((i % 250) + 1)
        .padStart(2, '0')
        .slice(-2)}AAAAA${String(1000 + (i % 250))}A1Z5`.slice(0, 15);
      const day = String((i % 27) + 1).padStart(2, '0');
      const taxable = 100_000 + i * 37;
      es.push(
        entry({
          id: `pe${i}`,
          supplierGstin: sup,
          number: `INV/${i}`,
          date: `2025-04-${day}`,
          taxable,
        }),
      );
      // a mix: exact, written differently, off in amount, and missing from the books
      if (i % 10 === 9) continue;
      bs.push(
        bill({
          id: `pb${i}`,
          supplierGstin: sup,
          number:
            i % 10 === 3
              ? `2025-26/INV/${i}`
              : i % 10 === 5
                ? `INV-${String(i).padStart(6, '0')}`
                : `INV/${i}`,
          date: `2025-04-${day}`,
          taxable: i % 10 === 7 ? taxable + 50_000 : taxable,
        }),
      );
    }
    const t0 = performance.now();
    const r = reconcile(es, bs);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(r.filter((x) => x.cls === 'in_2b_not_in_books')).toHaveLength(500);
    expect(r.filter((x) => x.cls === 'matched_with_differences').length).toBeGreaterThan(900);
  });
});

describe('reading GSTR-2B JSON', () => {
  const sample = {
    data: {
      gstin: G2,
      rtnprd: '042025',
      version: '1.0',
      docdata: {
        b2b: [
          {
            ctin: G1,
            trdnm: 'Acme Traders',
            supprd: '042025',
            inv: [
              {
                inum: 'INV/0012',
                typ: 'R',
                dt: '09-04-2025',
                val: 11800,
                itcavl: 'Y',
                items: [
                  { num: 1, rt: 18, txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 },
                  { num: 2, rt: 18, txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 },
                ],
              },
              {
                inum: 'X-9',
                dt: '12-04-2025',
                txval: 1000.5,
                igst: 180.09,
                itcavl: 'N',
                rsn: 'POS',
              },
              { inum: '', dt: '12-04-2025' },
              { inum: 'BAD', dt: '31-02-2025' },
            ],
          },
        ],
        cdnr: [
          {
            ctin: G1,
            trdnm: 'Acme Traders',
            nt: [{ ntnum: 'CN/3', typ: 'C', dt: '20-04-2025', txval: 100, cgst: 9, sgst: 9 }],
          },
        ],
        b2ba: [{ ctin: G1, inv: [{}] }],
      },
    },
  };

  it('reads invoices (summing items or using invoice-level amounts) and credit notes, in exact paise', () => {
    const r = parse2bJson(JSON.stringify(sample));
    expect(r).toMatchObject({ period: '042025', gstin: G2, version: 'v1' });
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0]).toMatchObject({
      supplierGstin: G1,
      supplierName: 'Acme Traders',
      docType: 'invoice',
      number: 'INV/0012',
      date: '2025-04-09',
      taxable: 1_000_000,
      cgst: 90_000,
      sgst: 90_000,
      itcAvailable: 'Y',
    });
    expect(r.entries[1]).toMatchObject({
      taxable: 100_050,
      igst: 18_009,
      itcAvailable: 'N',
      reason: 'POS',
    });
    expect(r.entries[2]).toMatchObject({
      docType: 'credit_note',
      number: 'CN/3',
      date: '2025-04-20',
      taxable: 10_000,
    });
  });

  it('keeps going past what it cannot read, and says what it skipped', () => {
    const r = parse2bJson(JSON.stringify(sample));
    expect(r.problems.some((p) => p.includes('no number'))).toBe(true);
    expect(r.problems.some((p) => p.includes('no valid date'))).toBe(true);
    expect(r.problems.some((p) => p.includes('b2ba'))).toBe(true);
  });

  it('leaves reverse-charge lines out (their credit comes from our own bills) and counts them', () => {
    const r = parse2bJson(
      JSON.stringify({
        data: {
          gstin: G2,
          rtnprd: '042025',
          docdata: {
            b2b: [
              {
                ctin: G1,
                inv: [
                  { inum: 'R1', dt: '01-04-2025', rev: 'Y', txval: 100, igst: 18 },
                  { inum: 'N1', dt: '01-04-2025', rev: 'N', txval: 100, igst: 18 },
                ],
              },
            ],
            cdnr: [
              { ctin: G1, nt: [{ ntnum: 'C1', typ: 'C', dt: '02-04-2025', rev: 'Y', txval: 10 }] },
            ],
          },
        },
      }),
    );
    expect(r.entries.map((e) => e.number)).toEqual(['N1']);
    expect(r.reverseChargeLeftOut).toBe(2);
    expect(r.problems).toEqual([]);
  });

  it('never throws on a file that is not a GSTR-2B', () => {
    expect(parse2bJson('not json').problems[0]).toMatch(/not valid JSON/);
    expect(parse2bJson('{"hello": 1}').problems[0]).toMatch(/does not look like a GSTR-2B/);
    expect(parse2bJson('[]').entries).toEqual([]);
  });

  it('reads amounts and dates in the forms people and portals write them', () => {
    expect(toPaise('₹1,23,456.50')).toBe(12_345_650);
    expect(toPaise('Rs. 99')).toBe(9_900);
    expect(toPaise('-5.5')).toBe(-550);
    expect(toPaise('')).toBe(0);
    expect(toPaise('abc')).toBeNull();
    expect(toIsoDate('09-04-2025')).toBe('2025-04-09');
    expect(toIsoDate('09/04/2025')).toBe('2025-04-09');
    expect(toIsoDate('2025-04-09')).toBe('2025-04-09');
    expect(toIsoDate('45756')).toBe('2025-04-09');
    expect(toIsoDate('31-02-2025')).toBeNull();
    expect(toPeriod('Apr-25')).toBe('042025');
    expect(toPeriod('04-2025')).toBe('042025');
    expect(toPeriod('2025-04')).toBe('042025');
    expect(toPeriod('whenever')).toBe('');
  });
});

describe('reading a GSTR-2B spreadsheet', () => {
  const rows = [
    ['Goods and Services Tax - GSTR-2B'],
    [''],
    [
      'GSTIN of supplier',
      'Trade/Legal name',
      'Invoice number',
      'Invoice type',
      'Invoice Date',
      'Invoice Value',
      'Taxable Value',
      'Integrated Tax',
      'Central Tax',
      'State/UT Tax',
      'Cess',
      'ITC Availability',
      'Reason',
    ],
    [
      G1,
      'Acme',
      'INV/0012',
      'Regular',
      '09-04-2025',
      '11,800.00',
      '10,000.00',
      '0',
      '900.00',
      '900.00',
      '0',
      'Yes',
      '',
    ],
    [
      G1,
      'Acme',
      'INV/0013',
      'Regular',
      '45757',
      '₹590.00',
      '500.00',
      '90.00',
      '',
      '',
      '',
      'No',
      'Blocked',
    ],
    ['', '', '', '', '', '', 'Total', '10,500.00'],
    [G1, 'Acme', 'INV/0014', 'Regular', 'soon', '1', '1', '0', '0', '0', '0', 'Yes', ''],
  ];

  it('finds the header, reads each column by its heading and skips totals and bad dates', () => {
    const r = parse2bTable(rows, { period: '042025', gstin: G2 });
    expect(r.version).toBe('xlsx-v1');
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({
      number: 'INV/0012',
      date: '2025-04-09',
      taxable: 1_000_000,
      cgst: 90_000,
      itcAvailable: 'Y',
    });
    expect(r.entries[1]).toMatchObject({
      date: '2025-04-10',
      taxable: 50_000,
      igst: 9_000,
      itcAvailable: 'N',
      reason: 'Blocked',
    });
    expect(r.problems.some((p) => p.includes('no valid date'))).toBe(true);
  });

  it('leaves reverse-charge rows of a spreadsheet out and counts them', () => {
    const r = parse2bTable(
      [
        [
          'GSTIN of supplier',
          'Invoice number',
          'Invoice Date',
          'Taxable Value',
          'Integrated Tax',
          'Reverse Charge',
        ],
        [G1, 'A1', '01-04-2025', '100', '18', 'No'],
        [G1, 'A2', '01-04-2025', '100', '18', 'Yes'],
      ],
      { period: '042025', gstin: G2 },
    );
    expect(r.entries.map((e) => e.number)).toEqual(['A1']);
    expect(r.reverseChargeLeftOut).toBe(1);
  });

  it('says plainly when there is no table', () => {
    expect(parse2bTable([['nothing here']], { period: '', gstin: '' }).problems[0]).toMatch(
      /No table/,
    );
  });
});

describe('what a reconciliation means', () => {
  const e = {
    ok: entry({ id: 'e-ok', number: 'A1' }),
    short: entry({ id: 'e-short', number: 'B2', cgst: 9_000, sgst: 9_000 }),
    na: entry({ id: 'e-na', number: 'C3', itcAvailable: 'N', reason: 'Blocked' }),
    only: entry({ id: 'e-only', number: 'D4' }),
  };
  const b = {
    ok: bill({ id: 'b-ok', number: 'A1' }),
    more: bill({ id: 'b-more', number: 'B2', cgst: 11_000, sgst: 11_000 }),
    na: bill({ id: 'b-na', number: 'C3' }),
    only: bill({ id: 'b-only', number: 'E5', cgst: 5_000, sgst: 5_000 }),
    dup: bill({ id: 'b-dup', number: 'a-1', date: '2025-04-11' }),
  };
  const entries = new Map(Object.values(e).map((x) => [x.id, x]));
  const books = new Map(Object.values(b).map((x) => [x.id, x]));
  const matches = reconcile([...entries.values()], [...books.values()]);

  it('sums the tiles', () => {
    const s = summarise(matches, entries, books);
    expect(s.counts).toEqual({
      matched: 2,
      matched_with_differences: 1,
      in_2b_not_in_books: 1,
      in_books_not_in_2b: 1,
      duplicate_in_books: 1,
    });
    // per 2B: four lines of 18,000 tax each (the not-available one is still on the portal)
    expect(s.per2b.cgst + s.per2b.sgst).toBe(4 * 18_000);
    expect(s.toDefer).toMatchObject({ cgst: 5_000, sgst: 5_000 });
    // reversed: the duplicate (9,000 + 9,000), the not-available one (9,000 + 9,000), the excess on B2 (2,000 + 2,000)
    expect(s.toReverse.cgst + s.toReverse.sgst).toBe(18_000 + 18_000 + 4_000);
    expect(s.only2b).toMatchObject({ cgst: 9_000, sgst: 9_000 });
  });

  it('turns outcomes into adjustments to GSTR-3B table 4, one row per reason', () => {
    const adj = adjustmentsFor(matches, entries, books);
    const find = (field: string, text: string) =>
      adj.find((a) => a.field === field && a.reason.includes(text))!;
    expect(find('itc.availableOther', 'not shown by the supplier')).toMatchObject({
      camt: -5_000,
      samt: -5_000,
    });
    expect(find('itc.availableOther', 'duplicate')).toMatchObject({ camt: -9_000, samt: -9_000 });
    expect(find('itc.availableOther', 'not available')).toMatchObject({
      camt: -9_000,
      samt: -9_000,
    });
    expect(find('itc.ineligibleOther', 'not available')).toMatchObject({
      camt: 9_000,
      samt: 9_000,
    });
    expect(find('itc.availableOther', 'claims more tax')).toMatchObject({
      camt: -2_000,
      samt: -2_000,
    });
    expect(adj.every((a) => a.reason.trim() !== '')).toBe(true);
  });

  it('makes no adjustment when everything matches', () => {
    const es = [entry({ number: 'Z1' })];
    const bs = [bill({ number: 'Z1' })];
    const m = reconcile(es, bs);
    expect(
      adjustmentsFor(m, new Map(es.map((x) => [x.id, x])), new Map(bs.map((x) => [x.id, x]))),
    ).toEqual([]);
  });

  it('counts no credit as claimed for a bill the person marked as not eligible', () => {
    const e1 = entry({ id: 'ie', number: 'N1' });
    const b1 = bill({ id: 'ib', number: 'N1', itcEligible: false });
    const m = reconcile([e1], [b1]);
    expect(m[0]!.cls).toBe('matched');
    const s = summarise(m, new Map([['ie', e1]]), new Map([['ib', b1]]));
    expect(s.perBooks).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(s.per2b.cgst).toBe(9_000);
    // nothing was claimed, so there is nothing to reverse or reduce
    expect(adjustmentsFor(m, new Map([['ie', e1]]), new Map([['ib', b1]]))).toEqual([]);
  });

  it('treats credit notes and returns as minus', () => {
    const cn = entry({ id: 'cn', docType: 'credit_note', number: 'CN1' });
    const pr = bill({ id: 'pr', type: 'purchase_return', number: 'CN1' });
    const s = summarise(reconcile([cn], [pr]), new Map([['cn', cn]]), new Map([['pr', pr]]));
    expect(s.per2b.cgst).toBe(-9_000);
    expect(s.perBooks.cgst).toBe(-9_000);
    expect(s.eligible.cgst).toBe(-9_000);
  });

  it('explains each class in words the screen can translate', () => {
    const by = (cls: string) => matches.find((m) => m.cls === cls)!;
    expect(explain(by('matched_with_differences'), e.short, b.more)).toMatchObject({
      key: 'differs',
      params: { fields: 'cgst,sgst' },
    });
    expect(explain(by('in_2b_not_in_books'), e.only)).toMatchObject({ key: 'only2b' });
    expect(explain(by('in_books_not_in_2b'), undefined, b.only)).toMatchObject({
      key: 'onlyBooks',
    });
    expect(explain(by('duplicate_in_books'), undefined, b.dup)).toMatchObject({
      key: 'duplicate',
      params: { number: 'a-1' },
    });
    const na = matches.find((m) => m.entryId === 'e-na')!;
    expect(explain(na, e.na, b.na)).toMatchObject({
      key: 'notAvailable',
      params: { reason: 'Blocked' },
    });
    expect(
      explain(
        matches.find((m) => m.cls === 'matched')!,
        e.ok,
        b.ok,
      ).key,
    ).toBe('matched');
  });

  it('tries a richer explanation first and falls back to the template when it fails or is absent', async () => {
    const m = matches.find((x) => x.cls === 'in_2b_not_in_books')!;
    expect((await explainWith(m, e.only, undefined)).text).toBeNull();
    expect((await explainWith(m, e.only, undefined, async () => 'model words')).text).toBe(
      'model words',
    );
    const failed = await explainWith(m, e.only, undefined, async () => {
      throw new Error('offline');
    });
    expect(failed.text).toBeNull();
    expect(failed.fallback.key).toBe('only2b');
  });
});
