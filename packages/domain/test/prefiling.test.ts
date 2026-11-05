import { describe, expect, it } from 'vitest';

import {
  issueKey,
  monthPeriod,
  prefilingChecks,
  reviewPeriod,
  type CheckContext,
  type GstrDoc,
  type GstrLine,
} from '../src';

const OWN = '27AAPFU0939F1ZV';
const P = monthPeriod(OWN, 2025, 4);

const line = (o: Partial<GstrLine> = {}): GstrLine => ({
  hsn: '6109',
  description: 'T-shirt',
  uqc: 'NOS',
  qtyMicros: 1_000_000,
  taxablePaise: 100_000,
  rateBp: 500,
  igstPaise: 0,
  cgstPaise: 2_500,
  sgstPaise: 2_500,
  cessPaise: 0,
  taxability: 'taxable',
  ...o,
});

let seq = 0;
const doc = (o: Partial<GstrDoc> = {}): GstrDoc => {
  seq += 1;
  const lines = o.lines ?? [line()];
  return {
    id: `d${seq}`,
    type: 'tax_invoice',
    status: 'issued',
    number: `INV/${String(seq).padStart(4, '0')}`,
    seriesKey: 'inv',
    date: '2025-04-10',
    partyName: `Buyer ${seq}`,
    partyGstin: '29AABCU9603R1ZJ',
    registered: true,
    partyComposition: false,
    partyState: '29',
    pos: '29',
    supplierState: '27',
    supplyType: 'inter',
    lut: false,
    reverseCharge: false,
    totalPaise: lines.reduce(
      (a, l) => a + l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise,
      0,
    ),
    linkedNumber: '',
    linkedDate: '',
    linkedTotalPaise: 0,
    lines: lines.map((l) => ({ ...l, igstPaise: 5_000, cgstPaise: 0, sgstPaise: 0 })),
    ...o,
  };
};

const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({
  today: '2025-05-01',
  gstinRequiredAbovePaise: 0,
  hsnRates: new Map(),
  cancelledWithPayments: new Set(),
  ...o,
});

const codes = (docs: GstrDoc[], c: CheckContext = ctx()) =>
  prefilingChecks(P, docs, c).map((i) => i.code);

describe('pre-filing checks', () => {
  it('finds nothing wrong with a clean month', () => {
    expect(codes([doc(), doc({ date: '2025-04-11' })])).toEqual([]);
  });

  it('finds the same buyer, date and amount twice under two numbers', () => {
    const a = doc({ partyGstin: '29AABCU9603R1ZJ', date: '2025-04-12' });
    const b = doc({ partyGstin: '29AABCU9603R1ZJ', date: '2025-04-12' });
    const r = prefilingChecks(P, [a, b], ctx());
    expect(r.map((i) => i.code)).toEqual(['duplicate_invoice']);
    expect(r[0]!.docId).toBe(b.id);
    expect(r[0]!.message).toContain(a.number);
  });

  it('asks for the details of a consumer above the limit the business set, and only then', () => {
    const big = doc({
      registered: false,
      partyGstin: '',
      supplyType: 'intra',
      pos: '27',
      totalPaise: 5_000_000,
    });
    expect(codes([big])).toEqual([]);
    expect(codes([big], ctx({ gstinRequiredAbovePaise: 5_000_000 }))).toEqual([
      'b2c_above_threshold_no_gstin',
    ]);
    expect(codes([big], ctx({ gstinRequiredAbovePaise: 5_000_001 }))).toEqual([]);
  });

  it('catches a supply type that contradicts the place of supply, and a place that differs from the buyer state', () => {
    expect(codes([doc({ supplyType: 'intra', pos: '29' })])).toContain('supply_type_pos_mismatch');
    expect(codes([doc({ supplyType: 'inter', pos: '27' })])).toContain('supply_type_pos_mismatch');
    expect(codes([doc({ supplyType: 'inter', pos: '29', partyState: '33' })])).toEqual([
      'pos_differs_from_party_state',
    ]);
    // exports and SEZ are not tested against the buyer state
    expect(codes([doc({ supplyType: 'export', pos: '96', partyState: '' })])).toEqual([]);
  });

  it('catches an HSN of a wrong length, and a rate the HSN list does not allow', () => {
    expect(codes([doc({ lines: [line({ hsn: '610' })] })])).toContain('hsn_invalid_length');
    expect(codes([doc({ lines: [line({ hsn: '61A9' })] })])).toContain('hsn_invalid_length');
    const rates = new Map([['6109', [500, 1200]]]);
    expect(
      codes([doc({ lines: [line({ hsn: '6109', rateBp: 500 })] })], ctx({ hsnRates: rates })),
    ).toEqual([]);
    expect(
      codes([doc({ lines: [line({ hsn: '6109', rateBp: 1800 })] })], ctx({ hsnRates: rates })),
    ).toEqual(['rate_not_matching_hsn']);
    // a longer code uses the master's shorter entry
    expect(
      codes([doc({ lines: [line({ hsn: '61091000', rateBp: 1800 })] })], ctx({ hsnRates: rates })),
    ).toEqual(['rate_not_matching_hsn']);
    // an unknown code, a non-GST line or an export is not tested
    expect(
      codes([doc({ lines: [line({ hsn: '9999', rateBp: 1800 })] })], ctx({ hsnRates: rates })),
    ).toEqual([]);
    expect(
      codes(
        [doc({ supplyType: 'export', pos: '96', lines: [line({ hsn: '6109', rateBp: 0 })] })],
        ctx({ hsnRates: rates }),
      ),
    ).toEqual([]);
  });

  it('makes one problem of the same HSN taxed at the same rate on many documents, and lists them', () => {
    const rates = new Map([['6109', [500]]]);
    const bad = (n: number) =>
      doc({
        number: `INV/${String(n).padStart(4, '0')}`,
        date: '2025-04-10',
        lines: [line({ hsn: '6109', rateBp: 1800 })],
      });
    const five = [bad(1), bad(2), bad(3), bad(4), bad(5)];
    const rateOnly = (docs: GstrDoc[]) =>
      prefilingChecks(P, docs, ctx({ hsnRates: rates })).filter(
        (i) => i.code === 'rate_not_matching_hsn',
      );
    const r = rateOnly(five);
    expect(r.map((i) => i.code)).toEqual(['rate_not_matching_hsn']);
    expect(r[0]!.message).toContain('INV/0001, INV/0002, INV/0003 and 2 more');
    expect(r[0]!.message).toContain('taxed at 18%');
    expect(r[0]!.group).toBe('6109@1800');
    // a different rate for the same HSN is a different problem
    const other = doc({ date: '2025-04-10', lines: [line({ hsn: '6109', rateBp: 2800 })] });
    expect(rateOnly([...five, other]).map((i) => i.group)).toEqual(['6109@1800', '6109@2800']);
  });

  it('keeps an acknowledgement of a grouped problem when more documents join the group', () => {
    const rates = new Map([['6109', [500]]]);
    const mk = (n: number) =>
      doc({
        number: `INV/${String(n).padStart(4, '0')}`,
        date: '2025-04-10',
        lines: [line({ hsn: '6109', rateBp: 1800 })],
      });
    const rate = (docs: GstrDoc[]) =>
      prefilingChecks(P, docs, ctx({ hsnRates: rates })).find(
        (i) => i.code === 'rate_not_matching_hsn',
      )!;
    const one = rate([mk(1)]);
    const more = rate([mk(1), mk(2), mk(3)]);
    expect(issueKey(more)).toBe(issueKey(one));
    expect(issueKey(more)).toBe('rate_not_matching_hsn:6109@1800');
  });

  it('catches a credit note larger than its invoice', () => {
    const cn = doc({
      type: 'credit_note',
      linkedNumber: 'INV/1',
      linkedTotalPaise: 50_000,
      totalPaise: 60_000,
    });
    expect(codes([cn])).toContain('credit_note_exceeds_invoice');
    expect(
      codes([
        doc({
          type: 'credit_note',
          linkedNumber: 'INV/1',
          linkedTotalPaise: 60_000,
          totalPaise: 60_000,
        }),
      ]),
    ).toEqual([]);
    expect(codes([doc({ type: 'credit_note', linkedTotalPaise: 0, totalPaise: 60_000 })])).toEqual(
      [],
    );
  });

  it('catches a document dated after today and a number dated earlier than the one before it', () => {
    expect(codes([doc({ date: '2025-04-20' })], ctx({ today: '2025-04-15' }))).toContain(
      'date_in_future',
    );
    const a = doc({ number: 'INV/0001', date: '2025-04-20' });
    const b = doc({ number: 'INV/0002', date: '2025-04-05' });
    const r = prefilingChecks(P, [a, b], ctx());
    expect(r.map((i) => i.code)).toEqual(['date_out_of_order']);
    expect(r[0]!.docId).toBe(b.id);
  });

  it('catches a cancelled document that still has a payment', () => {
    const c = doc({ status: 'cancelled' });
    expect(codes([c], ctx({ cancelledWithPayments: new Set([c.id]) }))).toEqual([
      'cancelled_with_payments',
    ]);
    expect(codes([c])).toEqual([]);
  });

  it('only looks at documents in the period', () => {
    expect(codes([doc({ date: '2025-03-31', supplyType: 'intra', pos: '29' })])).toEqual([]);
  });
});

describe('issue keys and acknowledgements', () => {
  const issue = {
    code: 'missing_pos',
    table: '4',
    docId: 'x',
    message: 'INV/1: the place of supply is missing',
  };
  it('gives the same problem the same key, and different problems different keys', () => {
    expect(issueKey(issue)).toBe(issueKey({ ...issue }));
    expect(issueKey(issue)).not.toBe(issueKey({ ...issue, docId: 'y' }));
    expect(issueKey(issue)).not.toBe(
      issueKey({ ...issue, message: 'INV/2: the place of supply is missing' }),
    );
  });

  it('counts a problem as blocking until it is acknowledged with a reason', () => {
    const bad = doc({ supplyType: 'intra', pos: '29' });
    const v = { gstin: OWN, scheme: 'regular' as const, minHsnDigits: 4 };
    const first = reviewPeriod(P, [bad], [], v, { checks: ctx() });
    const blocking = first.issues.filter((i) => i.code === 'supply_type_pos_mismatch');
    expect(blocking).toHaveLength(1);
    expect(first.blockers).toBe(first.issues.length);
    expect(first.blockers).toBeGreaterThan(0);

    const acknowledged = new Map(first.issues.map((i) => [i.key!, 'checked with the buyer']));
    const second = reviewPeriod(P, [bad], [], v, { checks: ctx(), acknowledged });
    expect(second.blockers).toBe(0);
    expect(second.issues.every((i) => i.acknowledged === 'checked with the buyer')).toBe(true);
    // fixing the document removes the problem, with or without an acknowledgement
    const fixed = reviewPeriod(P, [doc({ supplyType: 'inter', pos: '29' })], [], v, {
      checks: ctx(),
    });
    expect(fixed.issues.find((i) => i.code === 'supply_type_pos_mismatch')).toBeUndefined();
  });

  it('lists errors before warnings and never lists the same problem twice', () => {
    const v = { gstin: OWN, scheme: 'regular' as const, minHsnDigits: 4 };
    const r = reviewPeriod(
      P,
      [
        doc({ supplyType: 'inter', pos: '29', partyState: '33' }),
        doc({ supplyType: 'intra', pos: '29' }),
      ],
      [],
      v,
      { checks: ctx() },
    );
    const sev = r.issues.map((i) => i.severity);
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
    expect(new Set(r.issues.map((i) => i.key)).size).toBe(r.issues.length);
  });
});
