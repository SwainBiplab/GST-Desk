/**
 * An estimate of income tax for a proprietor, old regime against new, with advance tax and the interest
 * of sections 234B and 234C. It is an ESTIMATE: it ignores losses brought forward, capital gains, foreign
 * income, alternate minimum tax and anything not listed in the inputs. Every rate, slab and limit is in
 * `data/direct-tax.json`. Pure: no clock, money in paise as bigint, a trace for every step.
 */
import { parseIso } from '../fy';
import { BP, divRound } from '../money';
import { step, type TraceStep } from '../trace';

import {
  DIRECT_TAX,
  taxYearRules,
  type DirectTaxData,
  type Slab,
  type SurchargeSlab,
} from './data';
import { fyStartYear, monthsOrPart } from './dates';

export type Regime = 'new' | 'old';
export type AgeGroup = 'below60' | 'senior' | 'super_senior';

export type BusinessIncome =
  | { method: 'books'; netProfitPaise: bigint }
  | {
      method: '44AD';
      turnoverPaise: bigint;
      /** Share of the turnover received by account payee cheque, bank transfer or digital means, in basis points. */
      digitalShareBp: number;
    }
  | { method: '44ADA'; receiptsPaise: bigint; cashShareBp: number };

export interface IncomeTaxInput {
  fy: string;
  age: AgeGroup;
  business: BusinessIncome;
  /** Interest, rent and anything else taxable, apart from the business. */
  otherIncomePaise: bigint;
  /** Old regime only. Each is capped by the limits in the data. */
  deductions: {
    section80C: bigint;
    section80CCD1B: bigint;
    section80DSelf: bigint;
    section80DParents: bigint;
    parentsSenior: boolean;
    homeLoanInterest: bigint;
    /** Any other Chapter VI-A deduction, taken as entered. */
    other: bigint;
  };
  /** Tax already deducted or collected on the person's income (TDS the customers took, TCS). */
  creditPaise: bigint;
  /** Advance tax paid, with the dates it was paid. */
  advance: { date: string; paise: bigint }[];
  /** When the return will be filed; for interest under 234B. Defaults to 31 July after the year. */
  filingDate?: string;
}

export interface RegimeResult {
  regime: Regime;
  incomePaise: bigint;
  deductionsPaise: bigint;
  taxableIncomePaise: bigint;
  slabTaxPaise: bigint;
  rebatePaise: bigint;
  surchargePaise: bigint;
  cessPaise: bigint;
  totalTaxPaise: bigint;
  trace: TraceStep[];
}

export interface InstalmentRow {
  dueDate: string;
  /** What should have been paid by then, in total. */
  requiredPaise: bigint;
  paidPaise: bigint;
  shortfallPaise: bigint;
  months: number;
  interestPaise: bigint;
}

export interface InterestResult {
  /** Tax left to pay after the credits; what advance tax is judged against. */
  assessedPaise: bigint;
  advanceRequired: boolean;
  instalments: InstalmentRow[];
  section234BPaise: bigint;
  section234BMonths: number;
  section234CPaise: bigint;
  totalPaise: bigint;
}

export interface Estimate {
  fy: string;
  assessmentYear: string;
  presumptive: boolean;
  new: RegimeResult;
  old: RegimeResult;
  better: Regime;
  savingPaise: bigint;
  /** For the better regime: interest and what is left to pay. */
  interest: Record<Regime, InterestResult>;
  payablePaise: Record<Regime, bigint>;
  warnings: string[];
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const floorTo = (v: bigint, unit: bigint) => (v / unit) * unit;
const nearest = (v: bigint, unit: bigint) => divRound(v, unit) * unit;

/** Tax on an income by slabs; exact until the final rounding to the paisa. */
export function slabTax(income: bigint, slabs: readonly Slab[]): bigint {
  let prev = 0n;
  let numerator = 0n;
  for (const s of slabs) {
    const upper = s.upTo === null ? income : BigInt(s.upTo);
    if (income > prev) numerator += (min(income, upper) - prev) * BigInt(s.rateBp);
    if (s.upTo === null || income <= upper) break;
    prev = upper;
  }
  return divRound(numerator, BP);
}

function surchargeRate(
  income: bigint,
  slabs: readonly SurchargeSlab[],
): { rateBp: number; above: bigint; prevBp: number } {
  let rateBp = 0;
  let above = 0n;
  let prevBp = 0;
  for (const s of slabs) {
    if (income > BigInt(s.above)) {
      prevBp = rateBp;
      rateBp = s.rateBp;
      above = BigInt(s.above);
    }
  }
  return { rateBp, above, prevBp };
}

function businessIncome(
  b: BusinessIncome,
  data: DirectTaxData,
): { incomePaise: bigint; warnings: string[]; presumptive: boolean; note: string } {
  const warnings: string[] = [];
  if (b.method === 'books')
    return {
      incomePaise: b.netProfitPaise,
      warnings,
      presumptive: false,
      note: 'net profit from the books',
    };
  const p = data.incomeTax.presumptive;
  if (b.method === '44AD') {
    const cashBp = 10_000 - b.digitalShareBp;
    const limit =
      cashBp <= p['44AD'].cashReceiptShareLimitBp
        ? p['44AD'].turnoverLimitDigitalPaise
        : p['44AD'].turnoverLimitPaise;
    if (b.turnoverPaise > BigInt(limit))
      warnings.push('Turnover is above the limit for section 44AD, so it cannot be used.');
    const digital = divRound(b.turnoverPaise * BigInt(b.digitalShareBp), BP);
    const other = b.turnoverPaise - digital;
    const income =
      divRound(digital * BigInt(p['44AD'].digitalRateBp), BP) +
      divRound(other * BigInt(p['44AD'].rateBp), BP);
    return {
      incomePaise: income,
      warnings,
      presumptive: true,
      note: 'presumptive income, section 44AD',
    };
  }
  const limit =
    b.cashShareBp <= p['44ADA'].cashReceiptShareLimitBp
      ? p['44ADA'].receiptsLimitDigitalPaise
      : p['44ADA'].receiptsLimitPaise;
  if (b.receiptsPaise > BigInt(limit))
    warnings.push('Receipts are above the limit for section 44ADA, so it cannot be used.');
  return {
    incomePaise: divRound(b.receiptsPaise * BigInt(p['44ADA'].rateBp), BP),
    warnings,
    presumptive: true,
    note: 'presumptive income, section 44ADA',
  };
}

function computeRegime(
  regime: Regime,
  income: bigint,
  i: IncomeTaxInput,
  rules: NonNullable<ReturnType<typeof taxYearRules>>,
): RegimeResult {
  const trace: TraceStep[] = [];
  let deductions = 0n;
  if (regime === 'old') {
    const l = rules.old.limits;
    const senior = i.age !== 'below60';
    const d = i.deductions;
    const c80 = min(d.section80C, BigInt(l.section80C));
    const ccd = min(d.section80CCD1B, BigInt(l.section80CCD1B));
    const self = min(d.section80DSelf, BigInt(senior ? l.section80DSenior : l.section80D));
    const par = min(
      d.section80DParents,
      BigInt(d.parentsSenior ? l.section80DSenior : l.section80D),
    );
    const home = min(d.homeLoanInterest, BigInt(l.homeLoanInterest24b));
    deductions = c80 + ccd + self + par + home + d.other;
    trace.push(
      step(
        'it.deductions',
        { c80, ccd, self, par, home, other: d.other },
        deductions,
        'deductions allowed in the old regime, each capped at its limit',
      ),
    );
  }
  const gross = max(0n, income);
  const taxable = floorTo(max(0n, gross - deductions), 1000n); // s.288A: down to ten rupees
  trace.push(
    step(
      'it.taxable',
      { income: gross, deductions },
      taxable,
      'taxable income, rounded down to ten rupees',
    ),
  );

  const slabs = regime === 'new' ? rules.new.slabs : rules.old.slabsByAge[i.age];
  const slab = slabTax(taxable, slabs);
  trace.push(step('it.slab', { taxable }, slab, `${regime} regime slab tax`));

  const reb = regime === 'new' ? rules.new.rebate : rules.old.rebate;
  let rebate = 0n;
  if (taxable <= BigInt(reb.incomeLimitPaise)) rebate = min(slab, BigInt(reb.maxPaise));
  else if (regime === 'new') {
    // marginal relief: the tax cannot exceed the income above the rebate limit
    const over = taxable - BigInt(reb.incomeLimitPaise);
    if (slab > over) rebate = slab - over;
  }
  if (rebate > 0n)
    trace.push(
      step(
        'it.rebate',
        { taxable, slab },
        rebate,
        'rebate under section 87A (with marginal relief in the new regime)',
      ),
    );
  const afterRebate = slab - rebate;

  const sur = surchargeRate(
    taxable,
    regime === 'new' ? rules.new.surchargeSlabs : rules.old.surchargeSlabs,
  );
  let surcharge = divRound(afterRebate * BigInt(sur.rateBp), BP);
  if (sur.rateBp > 0) {
    // marginal relief: tax plus surcharge cannot exceed what it was at the threshold plus the income above it
    const atT = slabTax(sur.above, slabs);
    const atTotal = atT + divRound(atT * BigInt(sur.prevBp), BP);
    const ceiling = atTotal + (taxable - sur.above);
    if (afterRebate + surcharge > ceiling) surcharge = max(0n, ceiling - afterRebate);
    trace.push(
      step(
        'it.surcharge',
        { rateBp: sur.rateBp, above: sur.above },
        surcharge,
        'surcharge with marginal relief',
      ),
    );
  }
  const cess = divRound((afterRebate + surcharge) * BigInt(rules.cessBp), BP);
  const total = nearest(afterRebate + surcharge + cess, 1000n); // s.288B: nearest ten rupees
  trace.push(
    step(
      'it.total',
      { afterRebate, surcharge, cess },
      total,
      'tax, surcharge and cess, to the nearest ten rupees',
    ),
  );
  return {
    regime,
    incomePaise: gross,
    deductionsPaise: deductions,
    taxableIncomePaise: taxable,
    slabTaxPaise: slab,
    rebatePaise: rebate,
    surchargePaise: surcharge,
    cessPaise: cess,
    totalTaxPaise: total,
    trace,
  };
}

const dueIn = (fy: string, md: string): string => {
  const start = fyStartYear(fy);
  const year = Number(md.slice(0, 2)) >= 4 ? start : start + 1;
  return `${year}-${md}`;
};

/** Advance tax instalments for a year: the dates and the running total due by each. */
export function advanceTaxSchedule(
  fy: string,
  assessedPaise: bigint,
  presumptive: boolean,
  data: DirectTaxData = DIRECT_TAX,
): { dueDate: string; cumulativePaise: bigint }[] {
  const a = data.incomeTax.advanceTax;
  if (assessedPaise < BigInt(a.minimumLiabilityPaise)) return [];
  const list = presumptive ? a.instalments.slice(-1) : a.instalments;
  return list.map((x) => ({
    dueDate: dueIn(fy, x.due),
    cumulativePaise: nearest(
      divRound(assessedPaise * BigInt(presumptive ? 10_000 : x.cumulativeBp), BP),
      100n,
    ),
  }));
}

/** Interest under 234B and 234C on what is still to pay after the credits. */
export function interestOn(
  fy: string,
  assessedPaise: bigint,
  presumptive: boolean,
  advance: readonly { date: string; paise: bigint }[],
  filingDate: string,
  data: DirectTaxData = DIRECT_TAX,
): InterestResult {
  const a = data.incomeTax.advanceTax;
  const start = fyStartYear(fy);
  const fyStart = `${start}-04-01`;
  const fyEnd = `${start + 1}-03-31`;
  const required = assessedPaise >= BigInt(a.minimumLiabilityPaise);
  const none: InterestResult = {
    assessedPaise,
    advanceRequired: required,
    instalments: [],
    section234BPaise: 0n,
    section234BMonths: 0,
    section234CPaise: 0n,
    totalPaise: 0n,
  };
  if (!required) return none;
  const paidBy = (date: string) =>
    advance.filter((p) => p.date >= fyStart && p.date <= date).reduce((s, p) => s + p.paise, 0n);

  const list = presumptive ? a.instalments.slice(-1) : a.instalments;
  const rows: InstalmentRow[] = [];
  let c = 0n;
  for (const x of list) {
    const dueDate = dueIn(fy, x.due);
    const reqBp = presumptive ? 10_000 : x.cumulativeBp;
    const requiredPaise = divRound(assessedPaise * BigInt(reqBp), BP);
    const paidPaise = paidBy(dueDate);
    const relaxed =
      x.relaxedBp !== undefined && paidPaise >= divRound(assessedPaise * BigInt(x.relaxedBp), BP);
    const shortfall = relaxed ? 0n : floorTo(max(0n, requiredPaise - paidPaise), 10_000n);
    const interest = divRound(shortfall * BigInt(a.interestBpPerMonth) * BigInt(x.months), BP);
    c += interest;
    rows.push({
      dueDate,
      requiredPaise,
      paidPaise,
      shortfallPaise: shortfall,
      months: x.months,
      interestPaise: interest,
    });
  }

  const paidYear = paidBy(fyEnd);
  let b = 0n;
  const months = monthsOrPart(fyEnd, filingDate);
  if (paidYear < divRound(assessedPaise * BigInt(a.section234BThresholdBp), BP)) {
    const shortfall = floorTo(max(0n, assessedPaise - paidYear), 10_000n);
    b = divRound(shortfall * BigInt(a.interestBpPerMonth) * BigInt(months), BP);
  }
  return {
    assessedPaise,
    advanceRequired: true,
    instalments: rows,
    section234BPaise: b,
    section234BMonths: b > 0n ? months : 0,
    section234CPaise: c,
    totalPaise: b + c,
  };
}

export function estimateIncomeTax(
  i: IncomeTaxInput,
  data: DirectTaxData = DIRECT_TAX,
): Estimate | { error: string } {
  const rules = taxYearRules(i.fy, data);
  if (!rules) return { error: `The tax rules for ${i.fy} are not in the data.` };
  const biz = businessIncome(i.business, data);
  const income = biz.incomePaise + i.otherIncomePaise;
  const warnings = [...biz.warnings];
  if (biz.incomePaise < 0n)
    warnings.push(
      'The business shows a loss. Set-off and carry-forward of losses are not modelled; the loss is taken as nil.',
    );
  if (!data.verified)
    warnings.push(
      'The tax rules are not yet verified by a chartered accountant. Confirm with your CA.',
    );
  if (rules.note.startsWith('Assumed')) warnings.push(`Rules for ${i.fy}: ${rules.note}`);

  const newR = computeRegime('new', income, i, rules);
  const oldR = computeRegime('old', income, i, rules);
  const better: Regime = newR.totalTaxPaise <= oldR.totalTaxPaise ? 'new' : 'old';
  const filing = i.filingDate ?? `${fyStartYear(i.fy) + 1}-07-31`;
  parseIso(filing);
  const interest = {} as Record<Regime, InterestResult>;
  const payable = {} as Record<Regime, bigint>;
  for (const r of [newR, oldR]) {
    const assessed = max(0n, r.totalTaxPaise - i.creditPaise);
    interest[r.regime] = interestOn(i.fy, assessed, biz.presumptive, i.advance, filing, data);
    const paid = i.advance.reduce((s, p) => s + p.paise, 0n);
    payable[r.regime] = max(0n, assessed - paid) + interest[r.regime].totalPaise;
  }
  return {
    fy: i.fy,
    assessmentYear: rules.assessmentYear,
    presumptive: biz.presumptive,
    new: newR,
    old: oldR,
    better,
    savingPaise:
      (better === 'new' ? oldR : newR).totalTaxPaise -
      (better === 'new' ? newR : oldR).totalTaxPaise,
    interest,
    payablePaise: payable,
    warnings,
  };
}
