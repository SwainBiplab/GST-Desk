/**
 * Bulk golden vectors from an independent reference oracle.
 *
 * The oracle below re-derives every figure from the rules using plain positive-integer arithmetic
 * (floor-based half-up, its own largest-remainder loop) and shares no code with src/. Inputs come
 * from a seeded PRNG so the files are reproducible. Hand-checked cases live in hand.json.
 * Run: pnpm --filter @gst/domain vectors
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dump, type Vector, type VectorLine } from './vector-io';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261104);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** round half up for non-negative n, positive d */
const rh = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

interface Opts {
  supply: 'intra' | 'inter' | 'export' | 'sez_with_tax' | 'sez_without_tax' | 'deemed_export';
  supplierState: string;
  lut?: boolean;
  reverseCharge?: boolean;
  composition?: boolean;
  invoiceDiscount?: { mode: 'percent'; bp: number } | { mode: 'amount'; paise: bigint };
  roundOff?: 'none' | 'nearest_rupee';
  date?: string;
  tcs?: { rateBp: number; cumulativeBeforePaise: bigint };
  tds?: { rateBp: number; cumulativeBeforePaise: bigint; applicable?: boolean };
}

const LAKH50 = 500_000_000n;
const UT = new Set(['04', '26', '31', '35', '38']);

function oracle(lines: VectorLine[], o: Opts) {
  const heads = o.composition
    ? 'none'
    : o.supply === 'intra'
      ? UT.has(o.supplierState)
        ? 'cgst_utgst'
        : 'cgst_sgst'
      : o.supply === 'sez_without_tax'
        ? 'none'
        : o.supply === 'export'
          ? o.lut
            ? 'none'
            : 'igst'
          : 'igst';

  const priced = lines.map((l) => {
    const zero = heads === 'none' || (l.taxability ?? 'taxable') !== 'taxable';
    const rate = zero ? 0n : BigInt(l.gstRateBp);
    const cessAd = zero ? 0n : BigInt(l.cessBp ?? 0);
    const spec = zero ? 0n : rh(l.qtyMicros * (l.cessPerUnitPaise ?? 0n), 1_000_000n);
    const gross = rh(l.qtyMicros * l.ratePaise, 1_000_000n);
    let disc = 0n;
    if (l.discount.mode === 'percent') disc = rh(gross * BigInt(l.discount.bp), 10_000n);
    if (l.discount.mode === 'per_unit')
      disc = rh(l.qtyMicros * l.discount.perUnitPaise, 1_000_000n);
    if (disc > gross) disc = gross;
    const net = gross - disc;
    const inclusive = l.pricing === 'inclusive' || l.discount.mode === 'price_includes_tax';
    let taxable = net;
    if (inclusive) {
      const base = net - spec;
      taxable = base <= 0n ? 0n : rh(base * 10_000n, 10_000n + rate + cessAd);
    }
    return { rate, cessAd, spec, disc, taxable };
  });

  // invoice-level discount, largest remainder
  const sumT = priced.reduce((a, p) => a + p.taxable, 0n);
  let D = 0n;
  if (o.invoiceDiscount) {
    D =
      o.invoiceDiscount.mode === 'percent'
        ? rh(sumT * BigInt(o.invoiceDiscount.bp), 10_000n)
        : o.invoiceDiscount.paise;
    if (D > sumT) D = sumT;
  }
  const share = priced.map((p) => (sumT === 0n ? 0n : (D * p.taxable) / sumT));
  let left = D - share.reduce((a, x) => a + x, 0n);
  const order = priced
    .map((p, i) => ({ i, r: sumT === 0n ? 0n : (D * p.taxable) % sumT }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left <= 0n) break;
    share[i]! += 1n;
    left -= 1n;
  }

  const out = priced.map((p, i) => {
    const t = p.taxable - share[i]!;
    let cgst = 0n;
    let sgst = 0n;
    let utgst = 0n;
    let igst = 0n;
    if (p.rate > 0n) {
      if (heads === 'igst') igst = rh(t * p.rate, 10_000n);
      else {
        const h = rh(t * p.rate, 20_000n);
        cgst = h;
        if (heads === 'cgst_utgst') utgst = h;
        else sgst = h;
      }
    }
    const cess = p.cessAd > 0n || p.spec > 0n ? rh(t * p.cessAd, 10_000n) + p.spec : 0n;
    const tax = cgst + sgst + utgst + igst + cess;
    const total = t + (o.reverseCharge ? 0n : tax);
    return { taxable: t, cgst, sgst, utgst, igst, cess, tax, total, disc: p.disc };
  });

  const S = (f: (r: (typeof out)[number]) => bigint) => out.reduce((a, r) => a + f(r), 0n);
  const linesTotal = S((r) => r.total);
  const taxable = S((r) => r.taxable);

  let tcs = 0n;
  if (o.tcs && !o.tds?.applicable && !(o.date !== undefined && o.date >= '2025-04-01')) {
    let over = o.tcs.cumulativeBeforePaise + linesTotal - LAKH50;
    if (over < 0n) over = 0n;
    if (over > linesTotal) over = linesTotal;
    tcs = rh(over * BigInt(o.tcs.rateBp), 10_000n);
  }
  const before = linesTotal + tcs;
  const roundOff = o.roundOff === 'nearest_rupee' ? rh(before, 100n) * 100n - before : 0n;
  let tds = 0n;
  if (o.tds) {
    let over = o.tds.cumulativeBeforePaise + taxable - LAKH50;
    if (over < 0n) over = 0n;
    if (over > taxable) over = taxable;
    tds = rh(over * BigInt(o.tds.rateBp), 10_000n);
  }
  const total = before + roundOff;
  return {
    totals: {
      taxablePaise: taxable,
      cgstPaise: S((r) => r.cgst),
      sgstPaise: S((r) => r.sgst),
      utgstPaise: S((r) => r.utgst),
      igstPaise: S((r) => r.igst),
      cessPaise: S((r) => r.cess),
      taxPaise: S((r) => r.tax),
      rcmTaxPaise: o.reverseCharge ? S((r) => r.tax) : 0n,
      invoiceDiscountPaise: D,
      linesTotalPaise: linesTotal,
      tcsPaise: tcs,
      roundOffPaise: roundOff,
      totalPaise: total,
      tdsPaise: tds,
      netReceivablePaise: total - tds,
    },
    lines: out.map((r) => ({
      taxablePaise: r.taxable,
      cgstPaise: r.cgst,
      sgstPaise: r.sgst,
      utgstPaise: r.utgst,
      igstPaise: r.igst,
      cessPaise: r.cess,
      totalPaise: r.total,
    })),
  };
}

const RATES = [0, 50, 250, 300, 500, 1200, 1800, 2800];
const STATES = ['27', '29', '24', '33', '07', '19', '36'];

function randLine(extra: Partial<VectorLine> = {}): VectorLine {
  return {
    qtyMicros: BigInt(int(1, 40)) * 250_000n, // quarter units
    ratePaise: BigInt(int(1, 900_000)),
    discount: { mode: 'none' },
    gstRateBp: pick(RATES),
    ...extra,
  };
}

const byCategory = new Map<string, Vector[]>();
function gen(
  category: string,
  rule: string,
  n: number,
  make: (i: number) => { lines: VectorLine[]; options: Opts },
) {
  for (let i = 0; i < n; i++) {
    const { lines, options } = make(i);
    const exp = oracle(lines, options);
    const v: Vector = {
      name: `${category} #${i + 1}`,
      category,
      rule,
      input: { lines, options: options as unknown as Record<string, unknown> },
      expect: { totals: exp.totals, lines: exp.lines },
    };
    byCategory.set(category, [...(byCategory.get(category) ?? []), v]);
  }
}
const lines = (n: number, f: () => VectorLine = () => randLine()) => Array.from({ length: n }, f);
const intra = (extra: Partial<Opts> = {}): Opts => ({
  supply: 'intra',
  supplierState: pick(STATES),
  ...extra,
});
const inter = (extra: Partial<Opts> = {}): Opts => ({
  supply: 'inter',
  supplierState: pick(STATES),
  ...extra,
});

gen('intra', 'CGST s.8 / SGST s.9', 20, () => ({ lines: lines(int(1, 5)), options: intra() }));
gen('inter', 'IGST s.5', 15, () => ({ lines: lines(int(1, 5)), options: inter() }));
gen('utgst', 'UTGST Act s.8', 10, () => ({
  lines: lines(int(1, 3)),
  options: { supply: 'intra', supplierState: pick(['04', '26', '31', '35', '38']) },
}));
gen('cess', 'Compensation Cess s.8', 12, (i) => ({
  lines: lines(int(1, 3), () =>
    randLine({
      gstRateBp: 2800,
      ...(i % 3 !== 1 ? { cessBp: pick([100, 1200, 2200]) } : {}),
      ...(i % 3 !== 0 ? { cessPerUnitPaise: BigInt(int(50, 5000)) } : {}),
    }),
  ),
  options: i % 2 ? inter() : intra(),
}));
gen('composition', 'CGST s.10', 6, () => ({
  lines: lines(int(1, 3)),
  options: intra({ composition: true }),
}));
gen('exempt', 'exempt / nil / non-GST', 9, (i) => ({
  lines: lines(int(1, 3), () =>
    randLine({ taxability: pick(['exempt', 'nil_rated', 'non_gst'] as const) }),
  ),
  options: i % 2 ? inter() : intra(),
}));
gen('sez', 'IGST Act s.16', 8, (i) => ({
  lines: lines(int(1, 3)),
  options:
    i % 2
      ? { supply: 'sez_without_tax', supplierState: pick(STATES), lut: true }
      : { supply: 'sez_with_tax', supplierState: pick(STATES) },
}));
gen('export', 'IGST Act s.16', 8, (i) => ({
  lines: lines(int(1, 3)),
  options:
    i % 2
      ? { supply: 'export', supplierState: pick(STATES), lut: true }
      : { supply: 'export', supplierState: pick(STATES) },
}));
gen('rcm', 'CGST s.9(3)/(4)', 8, (i) => ({
  lines: lines(int(1, 3)),
  options: i % 2 ? inter({ reverseCharge: true }) : intra({ reverseCharge: true }),
}));
gen('inclusive', 'tax-inclusive price', 12, (i) => ({
  lines: lines(int(1, 3), () =>
    randLine({
      pricing: 'inclusive',
      ...(i % 3 === 0
        ? { discount: { mode: 'per_unit', perUnitPaise: BigInt(int(1, 500)) } as const }
        : {}),
      ...(i % 3 === 1
        ? { discount: { mode: 'percent', bp: pick([500, 1000, 1500]) } as const }
        : {}),
    }),
  ),
  options: i % 2 ? inter() : intra(),
}));
gen('discount', 'CGST s.15(3)', 12, (i) => ({
  lines: lines(int(1, 3), () =>
    randLine({
      discount:
        i % 2
          ? { mode: 'percent', bp: pick([100, 500, 1000, 2500, 5000]) }
          : { mode: 'per_unit', perUnitPaise: BigInt(int(1, 20_000)) },
    }),
  ),
  options: intra(),
}));
gen('invoice_discount', 'CGST s.15(3)', 14, (i) => ({
  lines: lines(int(2, 6)),
  options: intra({
    invoiceDiscount:
      i % 2
        ? { mode: 'percent', bp: pick([100, 500, 1000, 2000]) }
        : { mode: 'amount', paise: BigInt(int(1, 50_000)) },
  }),
}));
gen('round_off', 'invoice rounding', 10, () => ({
  lines: lines(int(1, 4)),
  options: intra({ roundOff: 'nearest_rupee' }),
}));
gen('tcs', 's.206C(1H)', 10, (i) => ({
  lines: [
    randLine({ ratePaise: BigInt(int(10_000_000, 60_000_000)), gstRateBp: pick([0, 500, 1800]) }),
  ],
  options: {
    ...intra(),
    date: i % 5 === 4 ? '2025-02-01' : '2024-05-10',
    tcs: { rateBp: pick([10, 100]), cumulativeBeforePaise: BigInt(int(0, 540_000_000)) },
    roundOff: 'nearest_rupee',
  },
}));
gen('tds', 's.194Q', 8, (i) => ({
  lines: [randLine({ ratePaise: BigInt(int(10_000_000, 90_000_000)), gstRateBp: pick([0, 1800]) })],
  options: {
    ...intra(),
    date: '2024-05-10',
    tds: {
      rateBp: 10,
      cumulativeBeforePaise: BigInt(int(0, 540_000_000)),
      applicable: i % 2 === 0,
    },
    tcs: { rateBp: 10, cumulativeBeforePaise: BigInt(int(300_000_000, 540_000_000)) },
  },
}));
gen('credit_note', 'CGST s.34', 6, () => {
  const rate = BigInt(int(1000, 500_000));
  const gst = pick(RATES);
  const units = BigInt(int(1, 3));
  return {
    lines: [
      {
        qtyMicros: units * 1_000_000n,
        ratePaise: rate,
        discount: { mode: 'none' },
        gstRateBp: gst,
      },
    ],
    options: intra(),
  };
});

let total = 0;
for (const [category, vs] of byCategory) {
  writeFileSync(
    join(import.meta.dirname, '..', 'test', 'vectors', `gen-${category}.json`),
    dump(vs),
  );
  total += vs.length;
}
console.log(`wrote ${byCategory.size} files, ${total} generated cases`);
