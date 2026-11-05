import { describe, expect, it } from 'vitest';

import {
  PostingError,
  allocate,
  amountToWordsEn,
  amountToWords,
  amountToWordsHi,
  b2clThreshold,
  checkGstin,
  computeDocument,
  computeLine,
  divRound,
  financialYear,
  fyOf,
  gstinCheckChar,
  gstr1Table,
  integerToWordsEn,
  isInward,
  isValidStateCode,
  paise,
  parseIso,
  parseScaled,
  postDocument,
  postPayment,
  qty,
  roundToRupee,
  rupees,
  sameFy,
  supplyType,
  taxHeadsFor,
  toDecimalString,
  today,
  turnoverSign,
  type LineInput,
  type PostableDocument,
} from '../src';

const line = (over: Partial<LineInput> = {}): LineInput => ({
  qtyMicros: 1_000_000n,
  ratePaise: 100_000n,
  discount: { mode: 'none' },
  gstRateBp: 1800,
  ...over,
});

describe('money', () => {
  it('brands only integers', () => {
    expect(paise(5)).toBe(5n);
    expect(paise('-12')).toBe(-12n);
    expect(paise(7n)).toBe(7n);
    expect(() => paise(1.5)).toThrow(RangeError);
    expect(() => paise('1.5')).toThrow(RangeError);
  });

  it('rounds half away from zero, including negatives', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(7n, -2n)).toBe(-4n);
    expect(() => divRound(1n, 0n)).toThrow();
    expect(roundToRupee(12350n)).toBe(12400n);
    expect(roundToRupee(-12350n)).toBe(-12400n);
    expect(roundToRupee(12349n)).toBe(12300n);
  });

  it('allocates exactly using largest remainder', () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocate(10n, [])).toEqual([]);
    expect(allocate(7n, [0n, 3n])).toEqual([0n, 7n]);
    expect(() => allocate(5n, [0n, 0n])).toThrow(RangeError);
  });

  it('parses decimals without floats', () => {
    expect(parseScaled('2.5', 6)).toBe(2_500_000n);
    expect(parseScaled('-0.125', 3)).toBe(-125n);
    expect(parseScaled('1.005', 2)).toBe(101n); // 5 rounds up
    expect(parseScaled('1.004', 2)).toBe(100n);
    expect(() => parseScaled('1e3', 2)).toThrow(RangeError);
    expect(qty('2.5')).toBe(2_500_000n);
    expect(rupees('1234.5')).toBe(123450n);
    expect(toDecimalString(12345600n)).toBe('123456.00');
    expect(toDecimalString(-5n)).toBe('-0.05');
    expect(toDecimalString(7n, 0)).toBe('7');
  });
});

describe('amount in words', () => {
  it('English, Indian grouping', () => {
    expect(amountToWordsEn(0n)).toBe('Rupees Zero Only');
    expect(amountToWordsEn(100n)).toBe('Rupees One Only');
    expect(amountToWordsEn(12345650n)).toBe(
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only',
    );
    expect(amountToWordsEn(1_000_000_000n)).toBe('Rupees One Crore Only');
    expect(amountToWordsEn(123_000_000_000n)).toBe('Rupees One Hundred Twenty Three Crore Only');
    expect(amountToWordsEn(5n)).toBe('Rupees Zero and Five Paise Only');
    expect(integerToWordsEn(19n)).toBe('Nineteen');
    expect(() => amountToWordsEn(-1n)).toThrow();
  });

  it('Hindi', () => {
    expect(amountToWordsHi(12345650n)).toBe(
      'एक लाख तेईस हज़ार चार सौ छप्पन रुपये और पचास पैसे मात्र',
    );
    expect(amountToWordsHi(100n)).toBe('एक रुपये मात्र');
    expect(amountToWordsHi(0n)).toBe('शून्य रुपये मात्र');
    expect(amountToWordsHi(1_000_000_000n)).toBe('एक करोड़ रुपये मात्र');
    expect(() => amountToWordsHi(-1n)).toThrow();
  });

  it('Hindi number table is correct at known positions', () => {
    const w = (n: number) => amountToWordsHi(BigInt(n) * 100n).replace(' रुपये मात्र', '');
    expect(w(11)).toBe('ग्यारह');
    expect(w(21)).toBe('इक्कीस');
    expect(w(33)).toBe('तैंतीस');
    expect(w(48)).toBe('अड़तालीस');
    expect(w(75)).toBe('पचहत्तर');
    expect(w(88)).toBe('अट्ठासी');
    expect(w(99)).toBe('निन्यानवे');
    expect(w(100)).toBe('एक सौ');
  });
});

describe('supply type', () => {
  it('classifies', () => {
    expect(supplyType('27', '27')).toBe('intra');
    expect(supplyType('27', '29')).toBe('inter');
    expect(supplyType('27', '96')).toBe('export');
    expect(supplyType('27', '27', { export: true })).toBe('export');
    expect(supplyType('27', '29', { sez: true })).toBe('sez_with_tax');
    expect(supplyType('27', '29', { sez: true, lut: true })).toBe('sez_without_tax');
    expect(supplyType('27', '29', { deemedExport: true })).toBe('deemed_export');
  });

  it('chooses tax heads including UTGST territories', () => {
    expect(taxHeadsFor('intra', '27')).toBe('cgst_sgst');
    for (const ut of ['04', '26', '31', '35', '38'])
      expect(taxHeadsFor('intra', ut)).toBe('cgst_utgst');
    for (const st of ['07', '34', '01']) expect(taxHeadsFor('intra', st)).toBe('cgst_sgst');
    expect(taxHeadsFor('inter', '27')).toBe('igst');
    expect(taxHeadsFor('export', '27')).toBe('igst');
    expect(taxHeadsFor('export', '27', { lut: true })).toBe('none');
    // a deemed export is taxable by the ordinary intra/inter test (s.147); IGST when the place is unknown
    expect(taxHeadsFor('deemed_export', '27')).toBe('igst');
    expect(taxHeadsFor('deemed_export', '27', {}, '29')).toBe('igst');
    expect(taxHeadsFor('deemed_export', '27', {}, '27')).toBe('cgst_sgst');
    expect(taxHeadsFor('deemed_export', '04', {}, '04')).toBe('cgst_utgst');
    expect(taxHeadsFor('sez_without_tax', '27')).toBe('none');
    expect(taxHeadsFor('deemed_export', '27')).toBe('igst');
  });

  it('validates state codes', () => {
    expect(isValidStateCode('27')).toBe(true);
    expect(isValidStateCode('96')).toBe(true);
    expect(isValidStateCode('25')).toBe(false);
  });
});

describe('GSTIN', () => {
  it('computes and checks', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(checkGstin('27aapfu0939f1zv')).toEqual({
      valid: true,
      stateCode: '27',
      pan: 'AAPFU0939F',
    });
    expect(checkGstin('27AAPFU0939F1ZX')).toEqual({ valid: false, reason: 'checksum' });
    expect(checkGstin('27AAPFU0939F1')).toEqual({ valid: false, reason: 'format' });
    expect(checkGstin('25AAPFU0939F1ZV')).toEqual({ valid: false, reason: 'state' });
    expect(() => gstinCheckChar('27aapfu0939f1z')).toThrow();
  });
});

describe('financial year', () => {
  it('rolls over on 1 April', () => {
    expect(fyOf('2026-03-31').label).toBe('25-26');
    expect(fyOf('2026-04-01').label).toBe('26-27');
    expect(fyOf('2026-04-01')).toMatchObject({ start: '2026-04-01', end: '2027-03-31' });
    expect(sameFy('2025-04-01', '2026-03-31')).toBe(true);
    expect(sameFy('2026-03-31', '2026-04-01')).toBe(false);
  });
  it('supports a January start and leap years', () => {
    expect(fyOf('2026-01-01', 1)).toMatchObject({
      label: '2026',
      start: '2026-01-01',
      end: '2026-12-31',
    });
    expect(financialYear(2023).end).toBe('2024-03-31');
    expect(financialYear(2024, 3).end).toBe('2025-02-28');
    expect(financialYear(2023, 3).end).toBe('2024-02-29');
    expect(() => financialYear(2025, 13)).toThrow();
  });
  it('validates dates and uses an injected clock in IST', () => {
    expect(() => parseIso('2026-02-30')).toThrow();
    expect(() => parseIso('26-1-1')).toThrow();
    // 19:00 UTC on 31 March is already 1 April in India
    expect(today(() => new Date('2026-03-31T19:00:00Z'))).toBe('2026-04-01');
    expect(today(() => new Date('2026-03-31T10:00:00Z'))).toBe('2026-03-31');
  });
});

describe('turnover and GSTR-1 tables', () => {
  it('counts only issued documents', () => {
    expect(turnoverSign('tax_invoice', 'issued')).toBe(1);
    expect(turnoverSign('tax_invoice', 'draft')).toBe(0);
    expect(turnoverSign('tax_invoice', 'cancelled')).toBe(0);
    expect(turnoverSign('credit_note', 'issued')).toBe(-1);
    expect(turnoverSign('debit_note', 'issued')).toBe(1);
    expect(turnoverSign('bill_of_supply', 'issued')).toBe(1);
    expect(turnoverSign('quotation', 'issued')).toBe(0);
    expect(turnoverSign('purchase_bill', 'issued')).toBe(0);
    expect(isInward('purchase_bill', 'issued')).toBe(true);
    expect(isInward('purchase_bill', 'draft')).toBe(false);
    expect(isInward('tax_invoice', 'issued')).toBe(false);
  });
  it('maps documents to tables', () => {
    const base = {
      type: 'tax_invoice',
      status: 'issued',
      supply: 'intra',
      registered: false,
      totalPaise: 5_000n,
      date: '2026-01-01',
    } as const;
    expect(gstr1Table(base)).toBe('B2CS');
    expect(gstr1Table({ ...base, registered: true })).toBe('B2B');
    expect(gstr1Table({ ...base, supply: 'inter', totalPaise: 10_000_001n })).toBe('B2CL');
    expect(gstr1Table({ ...base, supply: 'inter', totalPaise: 10_000_000n })).toBe('B2CS');
    expect(
      gstr1Table({ ...base, supply: 'inter', totalPaise: 20_000_000n, date: '2024-07-31' }),
    ).toBe('B2CS');
    expect(gstr1Table({ ...base, supply: 'export' })).toBe('EXP');
    expect(gstr1Table({ ...base, supply: 'sez_with_tax' })).toBe('B2B');
    expect(gstr1Table({ ...base, allNil: true })).toBe('NIL');
    expect(gstr1Table({ ...base, type: 'credit_note', registered: true })).toBe('CDNR');
    expect(gstr1Table({ ...base, type: 'credit_note' })).toBe('CDNUR');
    expect(gstr1Table({ ...base, status: 'draft' })).toBe('NONE');
    expect(b2clThreshold('2024-08-01')).toBe(10_000_000n);
    expect(b2clThreshold('2024-07-31')).toBe(25_000_000n);
  });
});

describe('engine behaviour', () => {
  it('is deterministic: same input, same output and trace', () => {
    const run = () =>
      computeDocument([line(), line({ gstRateBp: 500 })], {
        supply: 'intra',
        supplierState: '27',
        invoiceDiscount: { mode: 'percent', bp: 750 },
        roundOff: 'nearest_rupee',
      });
    expect(run()).toEqual(run());
  });

  it('produces a JSON-serialisable trace with the documented shape', () => {
    const { trace } = computeDocument([line()], { supply: 'intra', supplierState: '27' });
    expect(() => JSON.stringify(trace)).not.toThrow();
    for (const s of trace) {
      expect(typeof s.rule).toBe('string');
      expect(typeof s.note).toBe('string');
      expect(s).toHaveProperty('inputs');
      expect(s).toHaveProperty('output');
    }
    expect(trace.map((t) => t.rule)).toContain('lines[0].line.gst');
    expect(trace.map((t) => t.rule)).toContain('doc.total');
  });

  it('computeLine returns its own trace', () => {
    const { result, trace } = computeLine(line({ gstRateBp: 2800, cessBp: 100 }), {
      supply: 'inter',
      supplierState: '27',
    });
    expect(result.igstPaise).toBe(28000n);
    expect(trace.map((t) => t.rule)).toEqual(
      expect.arrayContaining([
        'line.gross',
        'line.discount',
        'line.taxable',
        'line.gst',
        'line.cess',
        'line.total',
      ]),
    );
  });

  it('explains why no tax applies', () => {
    const { trace } = computeLine(line({ taxability: 'exempt' }), {
      supply: 'intra',
      supplierState: '27',
    });
    expect(trace.find((t) => t.rule === 'line.no_tax')?.note).toMatch(/exempt/);
    const lut = computeLine(line(), { supply: 'export', supplierState: '27', lut: true });
    expect(lut.trace.find((t) => t.rule === 'line.no_tax')?.note).toMatch(/LUT/);
  });

  it('inclusive pricing keeps CGST equal to SGST and stays within a paisa of the entered price', () => {
    for (const rate of [99_999n, 100_001n, 118_001n, 333_333n]) {
      const { result } = computeLine(line({ ratePaise: rate, pricing: 'inclusive' }), {
        supply: 'intra',
        supplierState: '27',
      });
      expect(result.cgstPaise).toBe(result.sgstPaise);
      const drift = result.totalPaise - rate;
      expect(drift >= -2n && drift <= 2n).toBe(true);
    }
  });

  it('inclusive pricing backs out specific cess', () => {
    // price 1180 + specific cess 4/unit; GST 18% inter: taxable = (1180 - 4) / 1.18
    const { result } = computeLine(
      line({ ratePaise: 118_000n, pricing: 'inclusive', cessPerUnitPaise: 400n }),
      { supply: 'inter', supplierState: '27' },
    );
    expect(result.taxablePaise).toBe(99_661n);
    expect(result.cessPaise).toBe(400n);
  });

  it('handles an empty document and zero quantity', () => {
    const empty = computeDocument([], {
      supply: 'intra',
      supplierState: '27',
      roundOff: 'nearest_rupee',
    });
    expect(empty.result.totals.totalPaise).toBe(0n);
    const zero = computeDocument([line({ qtyMicros: 0n })], {
      supply: 'intra',
      supplierState: '27',
    });
    expect(zero.result.totals.totalPaise).toBe(0n);
  });

  it('invoice discount larger than the invoice is capped', () => {
    const { result } = computeDocument([line()], {
      supply: 'intra',
      supplierState: '27',
      invoiceDiscount: { mode: 'amount', paise: 999_999_999n },
    });
    expect(result.totals.taxablePaise).toBe(0n);
    expect(result.totals.totalPaise).toBe(0n);
  });

  it('TCS caps at the invoice value when already past the threshold', () => {
    const { result } = computeDocument([line({ gstRateBp: 0, ratePaise: 1_000_000n })], {
      supply: 'intra',
      supplierState: '27',
      date: '2024-05-01',
      tcs: { rateBp: 10, cumulativeBeforePaise: 900_000_000n },
    });
    expect(result.totals.tcsPaise).toBe(1_000n); // 0.1% of the whole 10,000.00
  });

  it('TDS stays zero below threshold and honours a custom threshold', () => {
    const below = computeDocument([line()], {
      supply: 'intra',
      supplierState: '27',
      tds: { rateBp: 10, cumulativeBeforePaise: 0n },
    });
    expect(below.result.totals.tdsPaise).toBe(0n);
    const custom = computeDocument([line({ gstRateBp: 0 })], {
      supply: 'intra',
      supplierState: '27',
      tds: { rateBp: 100, cumulativeBeforePaise: 0n, thresholdPaise: 50_000n },
    });
    expect(custom.result.totals.tdsPaise).toBe(500n); // 1% of 500.00 above 500.00
  });
});

describe('ledger posting', () => {
  const doc = (over: Partial<PostableDocument> = {}): PostableDocument => ({
    type: 'tax_invoice',
    status: 'issued',
    taxablePaise: 100_000n,
    cgstPaise: 9_000n,
    sgstPaise: 9_000n,
    utgstPaise: 0n,
    igstPaise: 0n,
    cessPaise: 0n,
    tcsPaise: 0n,
    roundOffPaise: 0n,
    totalPaise: 118_000n,
    ...over,
  });
  const dr = (ls: ReturnType<typeof postDocument>) => ls.reduce((a, l) => a + l.debitPaise, 0n);
  const cr = (ls: ReturnType<typeof postDocument>) => ls.reduce((a, l) => a + l.creditPaise, 0n);

  it('posts a sale: receivable against sales and output tax by head', () => {
    const ls = postDocument(doc());
    expect(ls.find((l) => l.account === 'receivables')?.debitPaise).toBe(118_000n);
    expect(ls.find((l) => l.account === 'sales')?.creditPaise).toBe(100_000n);
    expect(ls.find((l) => l.account === 'outputCgst')?.creditPaise).toBe(9_000n);
    expect(ls.find((l) => l.account === 'outputSgst')?.creditPaise).toBe(9_000n);
    expect(dr(ls)).toBe(cr(ls));
  });

  it('handles round-off both ways and TCS', () => {
    const up = postDocument(doc({ roundOffPaise: 40n, totalPaise: 118_040n }));
    expect(up.find((l) => l.account === 'roundOff')?.creditPaise).toBe(40n);
    const down = postDocument(doc({ roundOffPaise: -40n, totalPaise: 117_960n }));
    expect(down.find((l) => l.account === 'roundOff')?.debitPaise).toBe(40n);
    const tcs = postDocument(doc({ tcsPaise: 100n, totalPaise: 118_100n }));
    expect(tcs.find((l) => l.account === 'tcsPayable')?.creditPaise).toBe(100n);
    for (const ls of [up, down, tcs]) expect(dr(ls)).toBe(cr(ls));
  });

  it('reverses for credit notes', () => {
    const ls = postDocument(doc({ type: 'credit_note' }));
    expect(ls.find((l) => l.account === 'receivables')?.creditPaise).toBe(118_000n);
    expect(ls.find((l) => l.account === 'sales')?.debitPaise).toBe(100_000n);
    expect(ls.find((l) => l.account === 'outputCgst')?.debitPaise).toBe(9_000n);
  });

  it('posts purchases with input tax and payables, and returns reverse them', () => {
    const p = postDocument(doc({ type: 'purchase_bill' }));
    expect(p.find((l) => l.account === 'payables')?.creditPaise).toBe(118_000n);
    expect(p.find((l) => l.account === 'purchases')?.debitPaise).toBe(100_000n);
    expect(p.find((l) => l.account === 'inputCgst')?.debitPaise).toBe(9_000n);
    const r = postDocument(doc({ type: 'purchase_return' }));
    expect(r.find((l) => l.account === 'payables')?.debitPaise).toBe(118_000n);
    const e = postDocument(doc({ type: 'expense', roundOffPaise: 10n, totalPaise: 118_010n }));
    expect(e.find((l) => l.account === 'expenses')?.debitPaise).toBe(100_000n);
    expect(e.find((l) => l.account === 'roundOff')?.debitPaise).toBe(10n);
    for (const ls of [p, r, e]) expect(dr(ls)).toBe(cr(ls));
  });

  it('self-assesses reverse-charge purchases', () => {
    const ls = postDocument(
      doc({
        type: 'purchase_bill',
        reverseCharge: true,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 18_000n,
        totalPaise: 100_000n,
      }),
    );
    expect(ls.find((l) => l.account === 'payables')?.creditPaise).toBe(100_000n);
    expect(ls.find((l) => l.account === 'inputIgst')?.debitPaise).toBe(18_000n);
    expect(ls.find((l) => l.account === 'outputIgst')?.creditPaise).toBe(18_000n);
    const back = postDocument(
      doc({
        type: 'purchase_return',
        reverseCharge: true,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 18_000n,
        totalPaise: 100_000n,
      }),
    );
    expect(back.find((l) => l.account === 'inputIgst')?.creditPaise).toBe(18_000n);
    expect(dr(ls)).toBe(cr(ls));
    expect(dr(back)).toBe(cr(back));
  });

  it('skips non-posting types and rejects bad input', () => {
    for (const type of ['proforma', 'quotation', 'delivery_challan', 'receipt_voucher'] as const) {
      expect(postDocument(doc({ type }))).toEqual([]);
    }
    expect(() => postDocument(doc({ status: 'draft' }))).toThrow(PostingError);
    expect(() => postDocument(doc({ status: 'cancelled' }))).toThrow(PostingError);
    // total that does not match the parts must not post
    expect(() => postDocument(doc({ totalPaise: 1n }))).toThrow(/debits/);
    expect(() => postDocument(doc({ taxablePaise: -1n }))).toThrow(PostingError);
  });

  it('posts payments', () => {
    const rec = postPayment({ direction: 'received', mode: 'cash', amountPaise: 500n });
    expect(rec[0]).toMatchObject({ account: 'cash', debitPaise: 500n });
    expect(rec[1]).toMatchObject({ account: 'receivables', creditPaise: 500n });
    const made = postPayment({ direction: 'made', mode: 'upi', amountPaise: 700n });
    expect(made[0]).toMatchObject({ account: 'payables', debitPaise: 700n });
    expect(made[1]).toMatchObject({ account: 'bank', creditPaise: 700n });
    expect(() => postPayment({ direction: 'received', mode: 'cash', amountPaise: 0n })).toThrow(
      PostingError,
    );
  });
});

describe('amount in words by language', () => {
  it('uses Hindi for Hindi and Marathi and English for the rest, never blank', () => {
    expect(amountToWords('hi', 100n)).toBe('एक रुपये मात्र');
    expect(amountToWords('mr', 100n)).toBe(amountToWordsHi(100n));
    for (const l of ['en', 'ta', 'bn', 'gu', 'xx'])
      expect(amountToWords(l, 12345650n)).toBe(amountToWordsEn(12345650n));
  });
});
