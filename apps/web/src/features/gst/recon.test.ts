import type { ReconRow } from '@gst/db';
import type { Entry2B, Match } from '@gst/domain';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPrefill,
  impliedRateBp,
  peekPrefill,
  stashPrefill,
  type BillPrefill,
} from './prefill';
import { parseReturnFile } from './recon-file';
import {
  acceptableCount,
  actionsFor,
  countByClass,
  filterRows,
  linkableBills,
  tiles,
} from './recon-model';
import { XlsxError, readXlsxSheets } from './xlsx-read';

const G = '29AABCU9603R1ZJ';

/** A minimal .xlsx: shared strings, inline strings, numbers, a skipped column and entities. */
function workbook(sheets: string[][][]): Uint8Array {
  const shared: string[] = [];
  const idx = (t: string) => {
    let i = shared.indexOf(t);
    if (i < 0) i = shared.push(t) - 1;
    return i;
  };
  const colName = (n: number) => String.fromCharCode(65 + n);
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((rows, si) => {
    const body = rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) =>
              v === ''
                ? ''
                : /^-?\d+(\.\d+)?$/.test(v)
                  ? `<c r="${colName(ci)}${ri + 1}"><v>${v}</v></c>`
                  : `<c r="${colName(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`,
            )
            .join('')}</row>`,
      )
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`,
    );
  });
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0"?><sst>${shared
      .map((t) => `<si><t>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`)
      .join('')}</sst>`,
  );
  return zipSync(files);
}

const HEAD = [
  'GSTIN of supplier',
  'Trade/Legal name',
  'Invoice number',
  'Invoice type',
  'Invoice Date',
  'Taxable Value',
  'Integrated Tax',
  'Central Tax',
  'State/UT Tax',
  'Cess',
  'ITC Availability',
];

describe('the spreadsheet reader', () => {
  it('reads shared strings, numbers and gaps, keeping each cell in its column', () => {
    const [sheet] = readXlsxSheets(
      workbook([
        [
          ['a', 'b & c', '', 'd'],
          ['1', '', '2.5'],
        ],
      ]),
    );
    expect(sheet!.rows).toEqual([
      ['a', 'b & c', '', 'd'],
      ['1', '', '2.5'],
    ]);
  });

  it('reads inline strings and cells with entities', () => {
    const files = {
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>M&amp;M &lt;Ltd&gt;</t></is></c><c r="C1" t="str"><v>x</v></c></row></sheetData></worksheet>',
      ),
    };
    expect(readXlsxSheets(zipSync(files))[0]!.rows).toEqual([['M&M <Ltd>', '', 'x']]);
  });

  it('keeps worksheets in workbook order, and refuses what is not a workbook', () => {
    const two = readXlsxSheets(workbook([[['one']], [['two']]]));
    expect(two.map((s) => s.rows[0]![0])).toEqual(['one', 'two']);
    expect(() => readXlsxSheets(strToU8('not a zip file at all'))).toThrow(XlsxError);
    expect(() => readXlsxSheets(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/no worksheets/);
  });
});

describe('reading a downloaded file', () => {
  it('reads a spreadsheet: every sheet with a table, skipping the read-me, and takes the month from the person', async () => {
    const bytes = workbook([
      [['Read me'], ['This workbook holds GSTR-2B']],
      [
        ['GSTR-2B'],
        HEAD,
        [
          G,
          'Acme',
          'INV/0012',
          'Regular',
          '09-04-2025',
          '10000.00',
          '0',
          '900.00',
          '900.00',
          '0',
          'Yes',
        ],
        [G, 'Acme', 'INV/0013', 'Regular', '45757', '500.00', '90.00', '', '', '', 'No'],
      ],
    ]);
    const file = new File([bytes as BlobPart], 'GSTR2B_042025.xlsx');
    const r = await parseReturnFile(file, '042025', '27AAPFU0939F1ZV');
    expect(r.source).toBe('xlsx');
    expect(r.parsed).toMatchObject({
      period: '042025',
      gstin: '27AAPFU0939F1ZV',
      version: 'xlsx-v1',
    });
    expect(r.parsed.entries).toHaveLength(2);
    expect(r.parsed.entries[0]).toMatchObject({
      number: 'INV/0012',
      date: '2025-04-09',
      taxable: 1_000_000,
      cgst: 90_000,
    });
    expect(r.parsed.entries[1]).toMatchObject({ itcAvailable: 'N', date: '2025-04-10' });
    expect(r.hash === undefined || /^[0-9a-f]{64}$/.test(r.hash)).toBe(true);
  });

  it('says plainly when a workbook has no table of bills', async () => {
    const file = new File([workbook([[['nothing here']]]) as BlobPart], 'x.xlsx');
    await expect(parseReturnFile(file, '042025', G)).rejects.toThrow(/No sheet with a table/);
  });

  it('reads the portal JSON, with its own month', async () => {
    const json = JSON.stringify({
      data: {
        gstin: '27AAPFU0939F1ZV',
        rtnprd: '052025',
        docdata: {
          b2b: [
            {
              ctin: G,
              trdnm: 'Acme',
              inv: [{ inum: 'A1', dt: '02-05-2025', txval: 100, cgst: 9, sgst: 9, itcavl: 'Y' }],
            },
          ],
        },
      },
    });
    const r = await parseReturnFile(new File([json], 'GSTR2B.json'), '042025', '27AAPFU0939F1ZV');
    expect(r.source).toBe('json');
    expect(r.parsed.period).toBe('052025');
    expect(r.parsed.entries).toHaveLength(1);
  });
});

const entry = (o: Partial<Entry2B> = {}): Entry2B => ({
  id: 'e',
  supplierGstin: G,
  supplierName: 'Acme Traders',
  docType: 'invoice',
  number: 'INV/1',
  date: '2025-04-10',
  taxable: 1000,
  igst: 0,
  cgst: 90,
  sgst: 90,
  cess: 0,
  itcAvailable: 'Y',
  reason: '',
  supplierPeriod: '',
  period: '042025',
  ...o,
});

const row = (cls: Match['cls'], o: Partial<ReconRow> = {}): ReconRow => ({
  key: `${cls}-${Math.random()}`,
  match: {
    cls,
    entryId: 'e',
    billId: 'b',
    diffs: [],
    fuzzy: false,
    delta: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    duplicateOf: null,
  },
  entry: cls === 'in_books_not_in_2b' || cls === 'duplicate_in_books' ? null : entry(),
  bill:
    cls === 'in_2b_not_in_books'
      ? null
      : {
          id: 'b',
          supplierGstin: G,
          number: 'BILL-9',
          date: '2025-04-11',
          type: 'purchase_bill',
          taxable: 1000,
          igst: 0,
          cgst: 90,
          sgst: 90,
          cess: 0,
        },
  carried: false,
  decision: null,
  decisionRef: { side: 'entry', refKey: 'k' },
  explanation: { key: 'matched', params: {} },
  ...o,
});

describe('the reconciliation screen model', () => {
  const rows = [
    row('matched'),
    row('matched'),
    row('matched_with_differences'),
    row('in_2b_not_in_books'),
    row('in_books_not_in_2b'),
    row('duplicate_in_books'),
  ];

  it('counts and filters by class and by what the person types', () => {
    expect(countByClass(rows)).toEqual({
      all: 6,
      matched: 2,
      matched_with_differences: 1,
      in_2b_not_in_books: 1,
      in_books_not_in_2b: 1,
      duplicate_in_books: 1,
    });
    expect(filterRows(rows, { cls: 'matched', q: '' })).toHaveLength(2);
    expect(filterRows(rows, { cls: 'all', q: 'bill-9' })).toHaveLength(5);
    expect(filterRows(rows, { cls: 'all', q: 'acme' })).toHaveLength(4);
    expect(filterRows(rows, { cls: 'all', q: '29aabcu' })).toHaveLength(6);
    expect(filterRows(rows, { cls: 'all', q: 'nothing like this' })).toHaveLength(0);
    expect(filterRows(rows, { cls: 'in_2b_not_in_books', q: 'INV/1' })).toHaveLength(1);
  });

  it('offers the right actions for each class, and only undo once a decision exists', () => {
    expect(actionsFor(row('matched'))).toEqual(['accept']);
    expect(actionsFor(row('matched_with_differences'))).toEqual(['accept']);
    expect(actionsFor(row('in_2b_not_in_books'))).toEqual(['createBill', 'link', 'ignore']);
    expect(actionsFor(row('in_books_not_in_2b'))).toEqual(['toFile', 'ignore']);
    expect(actionsFor(row('duplicate_in_books'))).toEqual(['ignore']);
    expect(
      actionsFor(
        row('matched', {
          decision: { id: 'd', version: 1, decision: 'accept', linkedDocumentId: null, note: '' },
        }),
      ),
    ).toEqual(['undo']);
  });

  it('knows how many exact matches "accept all" would accept, and which bills a stray line can link to', () => {
    expect(acceptableCount(rows)).toBe(2);
    expect(
      acceptableCount([row('matched', { carried: true }), row('matched_with_differences')]),
    ).toBe(0);
    expect(linkableBills(rows)).toHaveLength(1);
    expect(
      linkableBills([
        row('in_books_not_in_2b', {
          decision: { id: 'd', version: 1, decision: 'ignore', linkedDocumentId: null, note: '' },
        }),
      ]),
    ).toHaveLength(0);
  });

  it('turns a summary into six tiles of total tax', () => {
    const h = (n: number) => ({ igst: n, cgst: n, sgst: n, cess: n });
    const t = tiles({
      per2b: h(10),
      perBooks: h(20),
      eligible: h(5),
      toDefer: h(1),
      toReverse: h(2),
      only2b: h(3),
      counts: {
        matched: 0,
        matched_with_differences: 0,
        in_2b_not_in_books: 0,
        in_books_not_in_2b: 0,
        duplicate_in_books: 0,
      },
    });
    expect(t.map((x) => [x.key, x.paise])).toEqual([
      ['per2b', 40],
      ['perBooks', 80],
      ['eligible', 20],
      ['defer', 4],
      ['reverse', 8],
      ['only2b', 12],
    ]);
  });
});

describe('starting a purchase bill from a 2B line', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    });
    return m;
  };
  const p: Omit<BillPrefill, 'at'> = {
    party: { id: 'p1', name: 'Acme', gstin: G, state_code: '29' },
    number: 'INV/12',
    date: '2025-04-09',
    taxable: 1_000_000,
    igst: 0,
    cgst: 90_000,
    sgst: 90_000,
    cess: 0,
  };

  it('hands the line over once, for a couple of minutes', () => {
    store();
    stashPrefill(p, 1_000);
    expect(peekPrefill(1_000 + 60_000)?.number).toBe('INV/12');
    // looking is not taking: React may look twice
    expect(peekPrefill(1_000 + 60_000)?.number).toBe('INV/12');
    expect(peekPrefill(1_000 + 3 * 60_000)).toBeNull();
    clearPrefill();
    expect(peekPrefill(1_000)).toBeNull();
  });

  it('copes with storage that is blocked or holds nonsense', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => stashPrefill(p)).not.toThrow();
    expect(peekPrefill()).toBeNull();
    expect(() => clearPrefill()).not.toThrow();
    const m = store();
    m.set('gst.prefill.bill', '{not json');
    expect(peekPrefill()).toBeNull();
  });

  it('works out the GST rate the tax implies, snapping rounding differences to a standard rate', () => {
    expect(impliedRateBp(1_000_000, 0, 90_000, 90_000)).toBe(1800);
    expect(impliedRateBp(1_000_000, 180_000, 0, 0)).toBe(1800);
    // a few paise of rounding is still 18%
    expect(impliedRateBp(1_000_000, 0, 90_001, 90_000)).toBe(1800);
    expect(impliedRateBp(333_333, 0, 8_333, 8_333)).toBe(500);
    // nothing taxed, or nothing taxable
    expect(impliedRateBp(1_000_000, 0, 0, 0)).toBe(0);
    expect(impliedRateBp(0, 100, 0, 0)).toBe(0);
    // an unusual rate stays as it is
    expect(impliedRateBp(1_000_000, 0, 45_000, 45_000)).toBe(900);
  });
});
