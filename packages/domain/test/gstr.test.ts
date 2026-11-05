import { describe, expect, it } from 'vitest';

import {
  GSTN_V1,
  blockers,
  buildGstr1,
  buildGstr3b,
  checkGstr1Json,
  checkGstr3bJson,
  crossCheck,
  dueDate,
  estimatePayment,
  filingStatus,
  gstinCheckChar,
  gstr1Csv,
  gstr1Json,
  gstr3bJson,
  monthPeriod,
  periodOf,
  periodsBetween,
  quarterPeriod,
  validateGstr1,
  type GstrDoc,
  type GstrLine,
} from '../src';

// real checksums, so the GSTIN validator accepts them
const OWN14 = '27AAPFU0939F1Z';
const GSTIN = OWN14 + gstinCheckChar(OWN14); // Maharashtra
const BUYER14 = '29AABCU9603R1Z';
const BUYER = BUYER14 + gstinCheckChar(BUYER14); // Karnataka
const P = monthPeriod(GSTIN, 2025, 4);

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
function doc(o: Partial<GstrDoc> = {}): GstrDoc {
  seq += 1;
  const lines = o.lines ?? [line()];
  const total = lines.reduce(
    (a, l) => a + l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise + l.cessPaise,
    0,
  );
  return {
    id: `d${seq}`,
    type: 'tax_invoice',
    status: 'issued',
    number: `INV/${String(seq).padStart(4, '0')}`,
    seriesKey: 'inv',
    date: '2025-04-10',
    partyName: 'Buyer',
    partyGstin: BUYER,
    registered: true,
    partyComposition: false,
    partyState: '29',
    pos: '27',
    supplierState: '27',
    supplyType: 'intra',
    lut: false,
    reverseCharge: false,
    totalPaise: total,
    linkedNumber: '',
    linkedDate: '',
    linkedTotalPaise: 0,
    lines,
    ...o,
  };
}

const inter = (taxable: number, rateBp = 1800) =>
  line({
    taxablePaise: taxable,
    rateBp,
    igstPaise: Math.round((taxable * rateBp) / 10000),
    cgstPaise: 0,
    sgstPaise: 0,
  });

describe('periods and due dates', () => {
  it('builds a month and a quarter with their boundaries', () => {
    expect(P).toMatchObject({ fp: '042025', from: '2025-04-01', to: '2025-04-30' });
    expect(monthPeriod(GSTIN, 2024, 2).to).toBe('2024-02-29');
    expect(quarterPeriod(GSTIN, 2025, 6)).toMatchObject({
      fp: '062025',
      from: '2025-04-01',
      to: '2025-06-30',
      kind: 'quarter',
    });
    expect(periodOf(GSTIN, '2025-08-15', 'quarter').fp).toBe('092025');
  });

  it('lists periods between two dates', () => {
    const ps = periodsBetween(GSTIN, '2025-02-10', '2025-04-02');
    expect(ps.map((p) => p.fp)).toEqual(['022025', '032025', '042025']);
  });

  it('computes the standard due dates and honours an override', () => {
    expect(dueDate('gstr1', P, '27').date).toBe('2025-05-11');
    expect(dueDate('gstr3b', P, '27').date).toBe('2025-05-20');
    const q = quarterPeriod(GSTIN, 2025, 6);
    expect(dueDate('gstr1', q, '27').date).toBe('2025-07-13');
    expect(dueDate('gstr3b', q, '27').date).toBe('2025-07-22'); // Maharashtra
    expect(dueDate('gstr3b', q, '07').date).toBe('2025-07-24'); // Delhi
    expect(dueDate('gstr1', P, '27', { 'gstr1:042025': '2025-05-15' })).toEqual({
      date: '2025-05-15',
      overridden: true,
    });
    // December rolls into January of the next year
    expect(dueDate('gstr1', monthPeriod(GSTIN, 2025, 12), '27').date).toBe('2026-01-11');
  });

  it('derives the status shown on a card', () => {
    const base = { hasDocuments: true, blockers: 0, due: '2025-05-11', today: '2025-05-01' };
    expect(filingStatus({ ...base, filed: false, exported: false })).toBe('ready');
    expect(filingStatus({ ...base, filed: false, exported: true })).toBe('exported');
    expect(filingStatus({ ...base, filed: true, exported: true })).toBe('filed');
    expect(filingStatus({ ...base, filed: false, exported: false, blockers: 2 })).toBe(
      'not_started',
    );
    expect(filingStatus({ ...base, hasDocuments: false, filed: false, exported: false })).toBe(
      'not_started',
    );
    expect(filingStatus({ ...base, today: '2025-05-12', filed: false, exported: true })).toBe(
      'late',
    );
    expect(filingStatus({ ...base, today: '2025-05-12', filed: true, exported: true })).toBe(
      'filed',
    );
  });
});

describe('GSTR-1 tables', () => {
  it('puts a regular invoice to a registered buyer in B2B, grouped by rate', () => {
    const d = doc({
      lines: [
        line({ taxablePaise: 170_000, cgstPaise: 4_250, sgstPaise: 4_250 }),
        line({
          hsn: '7323',
          taxablePaise: 120_000,
          rateBp: 1800,
          cgstPaise: 10_800,
          sgstPaise: 10_800,
        }),
        line({ taxablePaise: 30_000, cgstPaise: 750, sgstPaise: 750 }), // another 5% line
      ],
    });
    const g = buildGstr1(P, [d]);
    expect(g.b2b).toHaveLength(1);
    const inv = g.b2b[0]!.invoices[0]!;
    expect(inv.invTyp).toBe('R');
    expect(inv.items).toEqual([
      { rateBp: 500, txval: 200_000, iamt: 0, camt: 5_000, samt: 5_000, csamt: 0 },
      { rateBp: 1800, txval: 120_000, iamt: 0, camt: 10_800, samt: 10_800, csamt: 0 },
    ]);
    expect(g.totals).toEqual({ txval: 320_000, iamt: 0, camt: 15_800, samt: 15_800, csamt: 0 });
  });

  it('sends a large inter-state sale to a consumer to B2CL and the rest to B2CS', () => {
    const big = doc({
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [inter(15_000_000)], // 1,50,000.00 + 18%
    });
    const small = doc({
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [inter(5_000_000)],
    });
    const local = doc({ registered: false, partyGstin: '', lines: [line()] });
    const g = buildGstr1(P, [big, small, local]);
    expect(g.b2cl).toHaveLength(1);
    expect(g.b2cl[0]!.pos).toBe('29');
    expect(g.b2cl[0]!.invoices).toHaveLength(1);
    // the two small ones: Karnataka 18% (inter) and Maharashtra 5% (intra)
    expect(g.b2cs.map((r) => [r.pos, r.rateBp, r.txval])).toEqual([
      ['27', 500, 100_000],
      ['29', 1800, 5_000_000],
    ]);
  });

  it('tests the B2CL limit on the invoice value, not the taxable value', () => {
    // taxable 90,000 + 18% = 1,06,200 which is over 1,00,000
    const over = doc({
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [inter(9_000_000)],
    });
    expect(buildGstr1(P, [over]).b2cl).toHaveLength(1);
    // exactly at the limit stays in B2CS
    const at = doc({
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [line({ taxablePaise: 10_000_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 })],
    });
    const g = buildGstr1(P, [at]);
    expect(g.b2cl).toHaveLength(0);
    expect(g.b2cs).toHaveLength(1);
  });

  it('handles exports with and without payment, and SEZ supplies', () => {
    const wp = doc({
      supplyType: 'export',
      pos: '96',
      registered: false,
      partyGstin: '',
      lines: [inter(1_000_000)],
    });
    const wop = doc({
      supplyType: 'export',
      pos: '96',
      lut: true,
      registered: false,
      partyGstin: '',
      lines: [line({ taxablePaise: 500_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 })],
    });
    const sezWop = doc({
      supplyType: 'sez',
      lut: true,
      pos: '24',
      lines: [line({ taxablePaise: 700_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 })],
    });
    const sezWp = doc({ supplyType: 'sez', pos: '24', lines: [inter(200_000)] });
    const g = buildGstr1(P, [wp, wop, sezWop, sezWp]);
    expect(g.exp.map((x) => [x.expTyp, x.invoices.length])).toEqual([
      ['WOPAY', 1],
      ['WPAY', 1],
    ]);
    const types = g.b2b[0]!.invoices.map((i) => i.invTyp).sort();
    expect(types).toEqual(['SEWOP', 'SEWP']);
  });

  it('puts notes in CDNR, CDNUR or nets them against B2CS', () => {
    const cnReg = doc({
      type: 'credit_note',
      linkedNumber: 'INV/0001',
      lines: [line({ taxablePaise: 50_000, cgstPaise: 1_250, sgstPaise: 1_250 })],
    });
    const dnReg = doc({
      type: 'debit_note',
      lines: [line({ taxablePaise: 10_000, cgstPaise: 250, sgstPaise: 250 })],
    });
    const sale = doc({ registered: false, partyGstin: '', lines: [line()] });
    const cnSmall = doc({
      type: 'credit_note',
      registered: false,
      partyGstin: '',
      linkedTotalPaise: 105_000,
      lines: [line({ taxablePaise: 20_000, cgstPaise: 500, sgstPaise: 500 })],
    });
    const cnBig = doc({
      type: 'credit_note',
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      linkedTotalPaise: 20_000_000,
      lines: [inter(1_000_000)],
    });
    const g = buildGstr1(P, [cnReg, dnReg, sale, cnSmall, cnBig]);
    expect(g.cdnr[0]!.notes.map((n) => n.ntty).sort()).toEqual(['C', 'D']);
    expect(g.cdnur).toHaveLength(1);
    expect(g.cdnur[0]).toMatchObject({ typ: 'B2CL', ntty: 'C' });
    // consumer sale 1,000.00 less the small credit note 200.00
    expect(g.b2cs).toHaveLength(1);
    expect(g.b2cs[0]).toMatchObject({ pos: '27', rateBp: 500, txval: 80_000, camt: 2_000 });
    // net of credit notes: sale 1,000 - credit 500 + debit 100 - small credit 200 - large credit 10,000
    expect(g.totals.txval).toBe(100_000 - 50_000 + 10_000 - 20_000 - 1_000_000);
  });

  it('reports exempt, nil-rated and non-GST lines in table 8 and not in the tax tables', () => {
    const d = doc({
      lines: [
        line(),
        line({ taxability: 'exempt', taxablePaise: 30_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
        line({
          taxability: 'nil_rated',
          taxablePaise: 20_000,
          rateBp: 0,
          cgstPaise: 0,
          sgstPaise: 0,
        }),
      ],
    });
    const b = doc({
      type: 'bill_of_supply',
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [
        line({ taxability: 'non_gst', taxablePaise: 7_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
        line({ taxability: 'exempt', taxablePaise: 9_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
      ],
    });
    const g = buildGstr1(P, [d, b]);
    expect(g.nil).toEqual([
      { splyTy: 'INTRAB2B', exptAmt: 30_000, nilAmt: 20_000, ngsupAmt: 0 },
      { splyTy: 'INTRB2C', exptAmt: 9_000, nilAmt: 0, ngsupAmt: 7_000 },
    ]);
    expect(g.nilTotalPaise).toBe(66_000);
    expect(g.b2b[0]!.invoices[0]!.items).toHaveLength(1);
    expect(g.b2cs).toHaveLength(0); // the bill of supply has no taxable line
  });

  it('keeps unreportable export nil lines visible instead of dropping them', () => {
    const d = doc({
      supplyType: 'export',
      pos: '96',
      registered: false,
      partyGstin: '',
      lines: [
        line({ taxability: 'exempt', taxablePaise: 40_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
      ],
    });
    const g = buildGstr1(P, [d]);
    expect(g.unplacedPaise).toBe(40_000);
    expect(g.issues.some((i) => i.code === 'nil_line_not_reportable')).toBe(true);
  });

  it('splits the HSN summary into B2B and B2C and nets credit notes', () => {
    const b2b = doc({ lines: [line({ qtyMicros: 3_000_000 })] });
    const b2c = doc({ registered: false, partyGstin: '', lines: [line({ qtyMicros: 2_000_000 })] });
    const cn = doc({ type: 'credit_note', lines: [line({ qtyMicros: 1_000_000 })] });
    const g = buildGstr1(P, [b2b, b2c, cn]);
    expect(g.hsnB2b).toHaveLength(1);
    // 3 units sold and 1 credited: net 2 units; each document carries one INR 1,000 line, so the money nets to zero
    expect(g.hsnB2b[0]).toMatchObject({ hsn: '6109', qtyMicros: 2_000_000, txval: 0, val: 0 });
    expect(g.hsnB2c[0]).toMatchObject({ qtyMicros: 2_000_000, txval: 100_000 });
  });

  it('counts documents per series, including cancelled ones, and notes a gap', () => {
    const mk = (n: number, status: 'issued' | 'cancelled' = 'issued') =>
      doc({ number: `A/${String(n).padStart(3, '0')}`, seriesKey: 'A', status });
    const g = buildGstr1(P, [mk(1), mk(2, 'cancelled'), mk(3), mk(4)]);
    expect(g.docs).toEqual([
      {
        docNum: 1,
        docTyp: 'Invoices for outward supply',
        from: 'A/001',
        to: 'A/004',
        totnum: 4,
        cancel: 1,
        netIssue: 3,
      },
    ]);
    // a cancelled invoice is not in any table
    expect(g.b2b[0]!.invoices).toHaveLength(3);
    const gap = buildGstr1(P, [mk(1), mk(2), mk(5)]);
    expect(gap.issues.some((i) => i.code === 'series_gap')).toBe(true);
  });

  it('keeps separate ranges for each series and each kind of document', () => {
    const g = buildGstr1(P, [
      doc({ number: 'A/001', seriesKey: 'A' }),
      doc({ number: 'B/001', seriesKey: 'B' }),
      doc({ type: 'credit_note', number: 'CN/001', seriesKey: 'CN' }),
    ]);
    expect(g.docs.map((r) => [r.docNum, r.from])).toEqual([
      [1, 'A/001'],
      [1, 'B/001'],
      [5, 'CN/001'],
    ]);
  });

  it('ignores documents outside the period and drafts, proformas and purchases', () => {
    const g = buildGstr1(P, [
      doc({ date: '2025-03-31' }),
      doc({ date: '2025-05-01' }),
      doc({ type: 'purchase_bill' }),
    ]);
    expect(g.b2b).toHaveLength(0);
    expect(g.totals.txval).toBe(0);
  });

  it('flags a registered supply with no GSTIN as an error', () => {
    const g = buildGstr1(P, [doc({ partyGstin: '' })]);
    expect(g.issues.map((i) => i.code)).toContain('missing_recipient_gstin');
  });
});

describe('validation', () => {
  const ctx = { gstin: GSTIN, scheme: 'regular' as const, minHsnDigits: 4 };

  it('passes a clean month', () => {
    const docs = [doc(), doc({ registered: false, partyGstin: '' })];
    const issues = validateGstr1(buildGstr1(P, docs), docs, ctx);
    expect(blockers(issues)).toBe(0);
  });

  it('blocks on a bad number, missing place of supply, bad GSTIN and missing HSN', () => {
    const docs = [
      doc({ number: 'INVOICE/2025-26/000000001' }),
      doc({ pos: '' }),
      doc({ partyGstin: BUYER.slice(0, 14) + (BUYER.endsWith('A') ? 'B' : 'A') }),
      doc({ lines: [line({ hsn: '' })] }),
    ];
    const codes = validateGstr1(buildGstr1(P, docs), docs, ctx).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'document_number_format',
        'missing_pos',
        'recipient_gstin_invalid',
        'missing_hsn',
      ]),
    );
  });

  it('warns on a short HSN under the turnover rule', () => {
    const docs = [doc({ lines: [line({ hsn: '61' })] })];
    const issues = validateGstr1(buildGstr1(P, docs), docs, ctx);
    expect(issues.find((i) => i.code === 'hsn_too_short')?.severity).toBe('warning');
    expect(blockers(issues)).toBe(0);
  });

  it('refuses a composition business and a bad own GSTIN', () => {
    const issues = validateGstr1(buildGstr1(P, []), [], {
      gstin: 'BAD',
      scheme: 'composition',
      minHsnDigits: 4,
    });
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['composition_no_gstr1', 'own_gstin_invalid']),
    );
  });

  it('adds up every table against the documents', () => {
    const docs = [
      doc(),
      doc({ registered: false, partyGstin: '' }),
      doc({
        type: 'credit_note',
        lines: [line({ taxablePaise: 40_000, cgstPaise: 1_000, sgstPaise: 1_000 })],
      }),
      doc({
        supplyType: 'export',
        pos: '96',
        registered: false,
        partyGstin: '',
        lines: [inter(900_000)],
      }),
    ];
    const issues = validateGstr1(buildGstr1(P, docs), docs, ctx);
    expect(issues.find((i) => i.code === 'table_total_mismatch')).toBeUndefined();
    expect(issues.find((i) => i.code === 'hsn_total_mismatch')).toBeUndefined();
  });
});

describe('GSTR-3B', () => {
  const sales = [
    doc({ lines: [line({ taxablePaise: 1_000_000, cgstPaise: 25_000, sgstPaise: 25_000 })] }),
    doc({
      registered: false,
      partyGstin: '',
      supplyType: 'inter',
      pos: '29',
      lines: [inter(200_000)],
    }),
    doc({
      supplyType: 'export',
      pos: '96',
      registered: false,
      partyGstin: '',
      lines: [inter(300_000)],
    }),
    doc({
      lines: [
        line({ taxability: 'exempt', taxablePaise: 50_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
      ],
    }),
    doc({
      type: 'credit_note',
      lines: [line({ taxablePaise: 100_000, cgstPaise: 2_500, sgstPaise: 2_500 })],
    }),
  ];
  const purchases = [
    doc({
      type: 'purchase_bill',
      lines: [line({ taxablePaise: 400_000, cgstPaise: 10_000, sgstPaise: 10_000 })],
    }),
    doc({
      type: 'purchase_return',
      lines: [line({ taxablePaise: 40_000, cgstPaise: 1_000, sgstPaise: 1_000 })],
    }),
    doc({
      type: 'purchase_bill',
      reverseCharge: true,
      registered: false,
      partyGstin: '',
      lines: [line({ taxablePaise: 100_000, cgstPaise: 6_000, sgstPaise: 6_000, rateBp: 1200 })],
    }),
    doc({
      type: 'purchase_bill',
      supplyType: 'inter',
      lines: [
        line({ taxability: 'exempt', taxablePaise: 25_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
      ],
    }),
  ];

  it('fills tables 3.1, 3.2, 4 and 5 from the documents', () => {
    const { gstr3b: g } = buildGstr3b(P, [...sales, ...purchases]);
    // (a): 1,000,000 + 200,000 less the credit note 100,000
    expect(g.s31.a).toEqual({
      txval: 1_100_000,
      iamt: 36_000,
      camt: 22_500,
      samt: 22_500,
      csamt: 0,
    });
    expect(g.s31.b).toMatchObject({ txval: 300_000, iamt: 54_000 });
    expect(g.s31.c.txval).toBe(50_000);
    expect(g.s31.d).toMatchObject({ txval: 100_000, camt: 6_000, samt: 6_000 });
    expect(g.s32.unreg).toEqual([{ pos: '29', txval: 200_000, iamt: 36_000 }]);
    expect(g.s4.availableOther).toEqual({ iamt: 0, camt: 9_000, samt: 9_000, csamt: 0 });
    expect(g.s4.availableReverseCharge).toEqual({ iamt: 0, camt: 6_000, samt: 6_000, csamt: 0 });
    expect(g.s4.net).toEqual({ iamt: 0, camt: 15_000, samt: 15_000, csamt: 0 });
    expect(g.s5.gst).toEqual({ inter: 25_000, intra: 0 });
  });

  it('applies ITC adjustments and rejects an unknown field', () => {
    const { gstr3b: g, issues } = buildGstr3b(P, purchases, [
      {
        field: 'itc.reversedOther',
        iamt: 0,
        camt: 1_000,
        samt: 1_000,
        csamt: 0,
        reason: 'blocked credit',
      },
      { field: 'itc.nonsense', iamt: 1, camt: 0, samt: 0, csamt: 0, reason: 'x' },
    ]);
    expect(g.s4.reversedOther).toMatchObject({ camt: 1_000, samt: 1_000 });
    expect(g.s4.net.camt).toBe(6_000 + 9_000 - 1_000);
    expect(issues.map((i) => i.code)).toEqual(['unknown_adjustment']);
  });

  it('estimates payment: reverse charge in cash, the rest set off with credit in order', () => {
    const e = estimatePayment(
      { iamt: 10_000, camt: 5_000, samt: 5_000, csamt: 300 },
      { iamt: 0, camt: 1_000, samt: 1_000, csamt: 0 },
      { iamt: 12_000, camt: 4_000, samt: 1_000, csamt: 100 },
    );
    // IGST credit 12,000: 10,000 against IGST, the other 2,000 against CGST
    // CGST credit 4,000 against CGST (3,000 left): uses 3,000, 1,000 stays
    // SGST credit 1,000 against SGST
    expect(e.creditUsed).toEqual({ iamt: 12_000, camt: 3_000, samt: 1_000, csamt: 100 });
    expect(e.cashPayable).toEqual({ iamt: 0, camt: 1_000, samt: 5_000, csamt: 200 });
    expect(e.creditCarried.camt).toBe(1_000);
    expect(e.liability).toEqual({ iamt: 10_000, camt: 6_000, samt: 6_000, csamt: 300 });
  });

  it('agrees with GSTR-1 on outward supplies', () => {
    const all = [...sales, ...purchases];
    const g1 = buildGstr1(P, all);
    const { gstr3b } = buildGstr3b(P, all);
    expect(crossCheck(g1, gstr3b)).toEqual([]);
  });

  it('reports a difference between GSTR-1 and GSTR-3B', () => {
    const g1 = buildGstr1(P, sales);
    const { gstr3b } = buildGstr3b(P, sales.slice(1));
    expect(crossCheck(g1, gstr3b).map((i) => i.code)).toContain('gstr1_3b_taxable_mismatch');
  });
});

describe('JSON and CSV', () => {
  const docs = [
    doc({
      number: 'INV/1',
      seriesKey: 'inv',
      lines: [line({ taxablePaise: 170_000, cgstPaise: 4_250, sgstPaise: 4_250 })],
    }),
    doc({ number: 'INV/2', seriesKey: 'inv', registered: false, partyGstin: '', lines: [line()] }),
    doc({
      number: 'INV/3',
      seriesKey: 'inv',
      supplyType: 'export',
      pos: '96',
      registered: false,
      partyGstin: '',
      lines: [inter(900_000)],
    }),
    doc({
      number: 'CN/1',
      seriesKey: 'cn',
      type: 'credit_note',
      linkedNumber: 'INV/1',
      lines: [line({ taxablePaise: 40_000, cgstPaise: 1_000, sgstPaise: 1_000 })],
    }),
    doc({
      number: 'INV/4',
      seriesKey: 'inv',
      lines: [
        line({ taxability: 'exempt', taxablePaise: 30_000, rateBp: 0, cgstPaise: 0, sgstPaise: 0 }),
      ],
    }),
  ];

  /** Read a value deep inside a generated file without losing the type to `any`. */
  const at = (v: unknown, ...path: (string | number)[]): unknown =>
    path.reduce<unknown>((a, k) => (a as Record<string | number, unknown>)[k], v);

  it('writes a GSTR-1 file that matches the stored layout, with rupees, dates and codes', () => {
    const g = buildGstr1(P, docs);
    const json = gstr1Json(g);
    expect(checkGstr1Json(json)).toEqual([]);
    expect(json['fp']).toBe('042025');
    expect(at(json, 'b2b', 0, 'inv', 0)).toMatchObject({
      inum: 'INV/1',
      idt: '10-04-2025',
      val: 1785,
      pos: '27',
      rchrg: 'N',
      inv_typ: 'R',
    });
    expect(at(json, 'b2b', 0, 'inv', 0, 'itms', 0, 'itm_det')).toEqual({
      rt: 5,
      txval: 1700,
      camt: 42.5,
      samt: 42.5,
      csamt: 0,
    });
    expect(at(json, 'exp', 0, 'exp_typ')).toBe('WPAY');
    expect(at(json, 'nil', 'inv', 0)).toMatchObject({ sply_ty: 'INTRAB2B', expt_amt: 300 });
    expect(
      (at(json, 'doc_issue', 'doc_det') as { doc_num: number }[]).map((x) => x.doc_num),
    ).toEqual([1, 5]);
  });

  it('writes a GSTR-3B file that matches the stored layout', () => {
    const { gstr3b } = buildGstr3b(P, docs);
    const json = gstr3bJson(gstr3b);
    expect(checkGstr3bJson(json)).toEqual([]);
    expect(json['ret_period']).toBe('042025');
    expect((at(json, 'itc_elg', 'itc_avl') as { ty: string }[]).map((x) => x.ty)).toEqual([
      'IMPG',
      'IMPS',
      'ISRC',
      'ISD',
      'OTH',
    ]);
  });

  it('the structural check catches a wrong date, a wrong type and a missing key', () => {
    const bad = {
      gstin: GSTIN,
      fp: '4-2025',
      b2b: [{ ctin: 'X', inv: [{ idt: '2025-04-10', inv_typ: 'Q' }] }],
      zzz: 1,
    };
    const problems = checkGstr1Json(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        'fp must be MMYYYY',
        'unknown key zzz',
        expect.stringContaining('date must be DD-MM-YYYY'),
        expect.stringContaining('unknown invoice type Q'),
      ]),
    );
    expect(checkGstr3bJson({})).toContain('missing key gstin');
  });

  it('writes one review CSV per table with the documented headings', () => {
    const csv = gstr1Csv(buildGstr1(P, docs));
    expect(csv.b2b.split('\r\n')[0]).toContain('GSTIN/UIN of Recipient');
    expect(csv.b2b).toContain('INV/1');
    expect(csv.b2b).toContain('10-04-2025');
    expect(csv.exemp).toContain('Intra-State supplies to registered persons');
    expect(Object.keys(csv)).toHaveLength(10);
  });

  it('records that the layout is not verified', () => {
    expect(GSTN_V1.verified).toBe(false);
  });

  it('matches the golden files', async () => {
    const g = buildGstr1(P, docs);
    await expect(JSON.stringify(gstr1Json(g), null, 2)).toMatchFileSnapshot(
      './gstr/fixtures/gstr1-v1.golden.json',
    );
    const { gstr3b } = buildGstr3b(P, docs);
    await expect(JSON.stringify(gstr3bJson(gstr3b), null, 2)).toMatchFileSnapshot(
      './gstr/fixtures/gstr3b-v1.golden.json',
    );
  });
});
