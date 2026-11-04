/**
 * Hand-computed golden vectors. Every expected number below was worked out by hand from the rule
 * (see the comment on each case), NOT produced by the engine. Run: pnpm --filter @gst/domain vectors
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dump, type Vector, type VectorLine } from './vector-io';

const INTRA = { supply: 'intra', supplierState: '27' };
const INTER = { supply: 'inter', supplierState: '27' };

/** Line helper: qty in whole units, rate in paise. */
const line = (
  qty: number,
  rate: number,
  gstRateBp: number,
  extra: Partial<VectorLine> = {},
): VectorLine => ({
  qtyMicros: BigInt(qty) * 1_000_000n,
  ratePaise: BigInt(rate),
  discount: { mode: 'none' },
  gstRateBp,
  ...extra,
});

const big = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));

const vectors: Vector[] = [];
const add = (
  name: string,
  category: string,
  rule: string,
  lines: VectorLine[],
  options: Record<string, unknown>,
  totals: Record<string, number>,
  lineExpect?: Record<string, number>[],
) =>
  vectors.push({
    name,
    category,
    rule,
    input: { lines, options },
    expect: {
      totals: big(totals),
      ...(lineExpect ? { lines: lineExpect.map(big) } : {}),
    },
  });

// 1 x Rs1000 @18% intra: 9% + 9% of 1000.00
add('intra 18%', 'basic', 'CGST s.8, SGST s.9', [line(1, 100000, 1800)], INTRA, {
  taxablePaise: 100000,
  cgstPaise: 9000,
  sgstPaise: 9000,
  igstPaise: 0,
  totalPaise: 118000,
});
// same supply inter-state: IGST 18% = 18000
add('inter 18%', 'basic', 'IGST s.5', [line(1, 100000, 1800)], INTER, {
  taxablePaise: 100000,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 18000,
  totalPaise: 118000,
});
// 3 x 99.99 = 299.97; 6% = 17.9982 -> 18.00 (1800 paise) each head; total 299.97 + 36.00
add('rounding of each head', 'basic', 'half-up to paise', [line(3, 9999, 1200)], INTRA, {
  taxablePaise: 29997,
  cgstPaise: 1800,
  sgstPaise: 1800,
  totalPaise: 33597,
});
// taxable 100 paise at 5%: each head 2.5% = 2.5 paise -> rounds half up to 3
add('half paise rounds up', 'basic', 'half-up to paise', [line(1, 100, 500)], INTRA, {
  cgstPaise: 3,
  sgstPaise: 3,
  totalPaise: 106,
});
// 0%: no tax lines
add('zero-rated 0%', 'basic', 'rate 0', [line(2, 50000, 0)], INTRA, {
  taxablePaise: 100000,
  taxPaise: 0,
  totalPaise: 100000,
});

// 10% of 2 x 1000 = 200.00 discount; taxable 1800.00; 9% each = 162.00
add(
  'percent discount',
  'discount',
  'CGST s.15(3)',
  [line(2, 100000, 1800, { discount: { mode: 'percent', bp: 1000 } })],
  INTRA,
  {
    discountPaise: 20000,
    taxablePaise: 180000,
    cgstPaise: 16200,
    sgstPaise: 16200,
    totalPaise: 212400,
  },
);
// Rs50 off per unit x2 = 100.00; taxable 1900.00; 9% each = 171.00
add(
  'per-unit discount',
  'discount',
  'CGST s.15(3)',
  [line(2, 100000, 1800, { discount: { mode: 'per_unit', perUnitPaise: 5000n } })],
  INTRA,
  {
    discountPaise: 10000,
    taxablePaise: 190000,
    cgstPaise: 17100,
    sgstPaise: 17100,
    totalPaise: 224200,
  },
);
// per-unit discount larger than the rate is capped at the line value
add(
  'discount capped at line value',
  'discount',
  'discount cannot exceed value',
  [line(1, 10000, 1800, { discount: { mode: 'per_unit', perUnitPaise: 99999n } })],
  INTRA,
  {
    discountPaise: 10000,
    taxablePaise: 0,
    taxPaise: 0,
    totalPaise: 0,
  },
);

// price 1180.00 incl 18% -> taxable 1180/1.18 = 1000.00
add(
  'tax-inclusive back-calculation',
  'inclusive',
  'tax-inclusive price',
  [line(1, 118000, 1800, { pricing: 'inclusive' })],
  INTRA,
  {
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    totalPaise: 118000,
  },
);
add(
  'price_includes_tax alias',
  'inclusive',
  'tax-inclusive price',
  [line(1, 118000, 1800, { discount: { mode: 'price_includes_tax' } })],
  INTER,
  {
    taxablePaise: 100000,
    igstPaise: 18000,
    totalPaise: 118000,
  },
);
// 2 x 1180 less 118 per unit = 2124.00 incl; taxable 2124/1.18 = 1800.00; 9% each = 162.00
add(
  'tax-inclusive with per-unit discount',
  'inclusive',
  'tax-inclusive price + s.15(3)',
  [
    line(2, 118000, 1800, {
      pricing: 'inclusive',
      discount: { mode: 'per_unit', perUnitPaise: 11800n },
    }),
  ],
  INTRA,
  {
    discountPaise: 23600,
    taxablePaise: 180000,
    cgstPaise: 16200,
    sgstPaise: 16200,
    totalPaise: 212400,
  },
);

// supplier in Chandigarh (04): intra supply carries CGST + UTGST
add(
  'UTGST in Chandigarh',
  'utgst',
  'UTGST Act s.8',
  [line(1, 100000, 1800)],
  { supply: 'intra', supplierState: '04' },
  {
    cgstPaise: 9000,
    sgstPaise: 0,
    utgstPaise: 9000,
    totalPaise: 118000,
  },
);
// Delhi has a legislature: SGST, not UTGST
add(
  'Delhi uses SGST',
  'utgst',
  'SGST in UT with legislature',
  [line(1, 100000, 1800)],
  { supply: 'intra', supplierState: '07' },
  {
    cgstPaise: 9000,
    sgstPaise: 9000,
    utgstPaise: 0,
    totalPaise: 118000,
  },
);

// 28% IGST + 12% ad valorem cess on 1000.00 = 280.00 + 120.00
add(
  'ad valorem cess',
  'cess',
  'Compensation Cess s.8',
  [line(1, 100000, 2800, { cessBp: 1200 })],
  INTER,
  {
    igstPaise: 28000,
    cessPaise: 12000,
    totalPaise: 140000,
  },
);
// 5 x 100.00 = 500.00; GST 18% intra = 45.00 each; specific cess Rs4.00 x 5 = 20.00
add(
  'specific cess per unit',
  'cess',
  'Compensation Cess s.8',
  [line(5, 10000, 1800, { cessPerUnitPaise: 400n })],
  INTRA,
  {
    taxablePaise: 50000,
    cgstPaise: 4500,
    sgstPaise: 4500,
    cessPaise: 2000,
    totalPaise: 61000,
  },
);

add(
  'composition supplier charges no tax',
  'composition',
  'CGST s.10',
  [line(1, 100000, 1800)],
  { ...INTRA, composition: true },
  {
    taxablePaise: 100000,
    taxPaise: 0,
    totalPaise: 100000,
  },
);
add(
  'exempt supply',
  'exempt',
  'exempt supplies',
  [line(1, 100000, 500, { taxability: 'exempt' })],
  INTRA,
  {
    taxablePaise: 100000,
    taxPaise: 0,
    totalPaise: 100000,
  },
);
add(
  'non-GST supply',
  'exempt',
  'non-GST supplies',
  [line(1, 100000, 1800, { taxability: 'non_gst' })],
  INTER,
  {
    taxablePaise: 100000,
    taxPaise: 0,
    totalPaise: 100000,
  },
);

add(
  'SEZ with payment of tax',
  'sez',
  'IGST Act s.16(3)(b)',
  [line(1, 100000, 1800)],
  { supply: 'sez_with_tax', supplierState: '27' },
  {
    igstPaise: 18000,
    totalPaise: 118000,
  },
);
add(
  'SEZ without payment (LUT)',
  'sez',
  'IGST Act s.16(3)(a)',
  [line(1, 100000, 1800)],
  { supply: 'sez_without_tax', supplierState: '27', lut: true },
  {
    taxPaise: 0,
    totalPaise: 100000,
  },
);
add(
  'export with IGST paid',
  'export',
  'IGST Act s.16(3)(b)',
  [line(1, 100000, 1800)],
  { supply: 'export', supplierState: '27' },
  {
    igstPaise: 18000,
    totalPaise: 118000,
  },
);
add(
  'export under LUT',
  'export',
  'IGST Act s.16(3)(a)',
  [line(1, 100000, 1800)],
  { supply: 'export', supplierState: '27', lut: true },
  {
    taxPaise: 0,
    totalPaise: 100000,
  },
);

// reverse charge: IGST 180.00 computed but not invoiced
add(
  'reverse charge',
  'rcm',
  'CGST s.9(3)',
  [line(1, 100000, 1800)],
  { ...INTER, reverseCharge: true },
  {
    taxablePaise: 100000,
    igstPaise: 18000,
    rcmTaxPaise: 18000,
    totalPaise: 100000,
  },
);

// A 1000.00 @18% + B 500.00 @5%; 10% invoice discount = 150.00 split 100.00 / 50.00
// A: 900.00 -> 81.00 each head; B: 450.00 -> 2.5% = 11.25 each; totals 1062.00 + 472.50
add(
  'invoice discount across mixed rates',
  'invoice_discount',
  'CGST s.15(3)',
  [line(1, 100000, 1800), line(1, 50000, 500)],
  { ...INTRA, invoiceDiscount: { mode: 'percent', bp: 1000 } },
  {
    invoiceDiscountPaise: 15000,
    taxablePaise: 135000,
    cgstPaise: 9225,
    sgstPaise: 9225,
    linesTotalPaise: 153450,
    totalPaise: 153450,
  },
  [
    { taxablePaise: 90000, totalPaise: 106200 },
    { taxablePaise: 45000, totalPaise: 47250 },
  ],
);
// Rs 1.00 across three equal lines: 34 + 33 + 33 by largest remainder
add(
  'invoice discount remainder allocation',
  'invoice_discount',
  'pro rata allocation',
  [line(1, 10000, 0), line(1, 10000, 0), line(1, 10000, 0)],
  { ...INTRA, invoiceDiscount: { mode: 'amount', paise: 100n } },
  {
    invoiceDiscountPaise: 100,
    taxablePaise: 29900,
    totalPaise: 29900,
  },
  [{ taxablePaise: 9966 }, { taxablePaise: 9967 }, { taxablePaise: 9967 }],
);

// rate 1000.34, IGST 18% = 180.0612 -> 180.06; total 1180.40 -> 1180.00: round-off -0.40
add(
  'round-off down',
  'round_off',
  'invoice rounding',
  [line(1, 100034, 1800)],
  { ...INTER, roundOff: 'nearest_rupee' },
  {
    igstPaise: 18006,
    linesTotalPaise: 118040,
    roundOffPaise: -40,
    totalPaise: 118000,
  },
);
// total 335.97 -> 336.00: +0.03
add(
  'round-off up',
  'round_off',
  'invoice rounding',
  [line(3, 9999, 1200)],
  { ...INTRA, roundOff: 'nearest_rupee' },
  {
    linesTotalPaise: 33597,
    roundOffPaise: 3,
    totalPaise: 33600,
  },
);
// exactly 1534.50 rounds half up to 1535.00
add(
  'round-off at exactly half',
  'round_off',
  'invoice rounding',
  [line(1, 153450, 0)],
  { ...INTRA, roundOff: 'nearest_rupee' },
  {
    roundOffPaise: 50,
    totalPaise: 153500,
  },
);

// cumulative 49,00,000 + invoice 2,00,000 = 51,00,000: 1,00,000 above threshold x 0.1% = Rs 100.00
add(
  'TCS threshold crossed mid-invoice',
  'tcs',
  'Income-tax Act s.206C(1H)',
  [line(1, 20000000, 0)],
  { ...INTRA, date: '2024-06-15', tcs: { rateBp: 10, cumulativeBeforePaise: 490000000n } },
  {
    linesTotalPaise: 20000000,
    tcsPaise: 10000,
    totalPaise: 20010000,
  },
);
add(
  'TCS not collected below threshold',
  'tcs',
  'Income-tax Act s.206C(1H)',
  [line(1, 20000000, 0)],
  { ...INTRA, date: '2024-06-15', tcs: { rateBp: 10, cumulativeBeforePaise: 100000000n } },
  {
    tcsPaise: 0,
    totalPaise: 20000000,
  },
);
add(
  'TCS omitted from 1 Oct 2024',
  'tcs',
  'Finance (No.2) Act 2024',
  [line(1, 20000000, 0)],
  { ...INTRA, date: '2025-01-10', tcs: { rateBp: 10, cumulativeBeforePaise: 490000000n } },
  {
    tcsPaise: 0,
    totalPaise: 20000000,
  },
);
// purchases 45,00,000 + 10,00,000 = 55,00,000: 5,00,000 above threshold x 0.1% = Rs 500.00
add(
  'TDS 194Q above threshold',
  'tds',
  'Income-tax Act s.194Q',
  [line(1, 100000000, 0)],
  { ...INTRA, tds: { rateBp: 10, cumulativeBeforePaise: 450000000n } },
  {
    tdsPaise: 50000,
    totalPaise: 100000000,
    netReceivablePaise: 99950000,
  },
);
add(
  'TDS and TCS are mutually exclusive',
  'tds',
  's.194Q vs s.206C(1H)',
  [line(1, 20000000, 0)],
  {
    ...INTRA,
    date: '2024-06-15',
    tcs: { rateBp: 10, cumulativeBeforePaise: 490000000n },
    tds: { rateBp: 10, cumulativeBeforePaise: 490000000n, applicable: true },
  },
  {
    tcsPaise: 0,
    tdsPaise: 10000,
    totalPaise: 20000000,
  },
);

// invoice: 5 x 1000 @18% = 5900.00; credit note for 2 units = 2360.00; 3 units remain = 3540.00
add('invoice (5 units)', 'credit_note', 'CGST s.34', [line(5, 100000, 1800)], INTRA, {
  taxablePaise: 500000,
  cgstPaise: 45000,
  sgstPaise: 45000,
  totalPaise: 590000,
});
add(
  'credit note reversing 2 of 5 units',
  'credit_note',
  'CGST s.34',
  [line(2, 100000, 1800)],
  INTRA,
  {
    taxablePaise: 200000,
    cgstPaise: 18000,
    sgstPaise: 18000,
    totalPaise: 236000,
  },
);

writeFileSync(join(import.meta.dirname, '..', 'test', 'vectors', 'hand.json'), dump(vectors));
console.log(`wrote hand.json (${vectors.length} cases)`);
