/**
 * TDS (tax deducted when we pay) and TCS (tax collected when we sell), worked out from the rules in
 * `data/direct-tax.json`. Pure: no clock, no storage. Every result carries its trace.
 *
 * Rules applied: thresholds by section (a single payment, the year's total, or only the part above it),
 * the higher rate when the payee has no PAN (s.206AA, s.206CC), a lower-deduction certificate (s.197),
 * and rounding of the tax to the nearest rupee (s.288B).
 */
import { PAN } from '../gstin';
import { BP, divRound, roundToRupee } from '../money';
import { step, type TraceStep } from '../trace';

import {
  DIRECT_TAX,
  periodAt,
  tcsRule,
  tdsRule,
  type DirectTaxData,
  type RulePeriod,
} from './data';

export interface LowerCert {
  rateBp: number;
  validFrom: string;
  validTo: string;
  /** The most the certificate covers, in paise; unlimited when absent. */
  limitPaise?: bigint;
  /** How much of that limit earlier deductions have used. */
  usedPaise?: bigint;
}

export interface TdsInput {
  section: string;
  /** The date of payment or credit, whichever is earlier. */
  date: string;
  /** The amount the tax is on, already without GST where the section says so. */
  basePaise: bigint;
  pan: string;
  category?: 'individual_huf' | 'other';
  kind?: 'professional' | 'technical';
  /** What the party has been paid or credited under this section this year, before this payment. */
  cumulativeBeforePaise: bigint;
  /** The part of that on which tax has already been deducted. */
  alreadyBasePaise: bigint;
  lower?: LowerCert | null;
  /** 194Q: the buyer's turnover in the previous year. Unknown means the floor is not checked. */
  buyerTurnoverPaise?: bigint;
}

export interface Deduction {
  applies: boolean;
  /** What the tax is on (can include earlier payments caught up when a threshold is crossed). */
  basePaise: bigint;
  rateBp: number;
  taxPaise: bigint;
  noPan: boolean;
  lowerCert: boolean;
  /** One line saying why (or why not), for the screen. */
  why: string;
  trace: TraceStep[];
}

const nothing = (why: string, trace: TraceStep[]): Deduction => ({
  applies: false,
  basePaise: 0n,
  rateBp: 0,
  taxPaise: 0n,
  noPan: false,
  lowerCert: false,
  why,
  trace,
});

export const hasPan = (pan: string): boolean => PAN.test(pan.trim().toUpperCase());

function rateFor(rule: ReturnType<typeof tdsRule>, p: RulePeriod, i: TdsInput): number | null {
  if (!rule) return null;
  if (rule.categories) return rule.categories[i.category ?? 'other'];
  if (rule.kinds) return rule.kinds[i.kind ?? 'professional'];
  return p.rateBp ?? null;
}

/** Tax on a base at a rate, rounded to the nearest rupee. */
const tax = (base: bigint, rateBp: number): bigint =>
  roundToRupee(divRound(base * BigInt(rateBp), BP));

function lowerPortion(
  lower: LowerCert | null | undefined,
  date: string,
  base: bigint,
): { covered: bigint; rateBp: number } | null {
  if (!lower || date < lower.validFrom || date > lower.validTo) return null;
  const room =
    lower.limitPaise === undefined
      ? base
      : lower.limitPaise > (lower.usedPaise ?? 0n)
        ? lower.limitPaise - (lower.usedPaise ?? 0n)
        : 0n;
  const covered = room < base ? room : base;
  return covered > 0n ? { covered, rateBp: lower.rateBp } : null;
}

export function computeTds(i: TdsInput, data: DirectTaxData = DIRECT_TAX): Deduction {
  const rule = tdsRule(i.section, data);
  if (!rule) return nothing(`${i.section} is not a section this software knows.`, []);
  const p = periodAt(rule.periods, i.date);
  if (!p) return nothing(`${i.section} does not apply on ${i.date}.`, []);
  const rate = rateFor(rule, p, i);
  if (rate === null) return nothing(`No rate is set for ${i.section}.`, []);
  const trace: TraceStep[] = [];

  if (
    rule.buyerTurnoverFloorPaise !== undefined &&
    i.buyerTurnoverPaise !== undefined &&
    i.buyerTurnoverPaise <= BigInt(rule.buyerTurnoverFloorPaise)
  ) {
    return nothing(
      `${i.section} applies only to a buyer whose turnover last year was above the limit.`,
      [
        step(
          'tds.floor',
          { turnover: i.buyerTurnoverPaise },
          0,
          'buyer turnover is under the limit',
        ),
      ],
    );
  }

  const total = i.cumulativeBeforePaise + i.basePaise;
  const single = p.singleThresholdPaise === undefined ? null : BigInt(p.singleThresholdPaise);
  const aggregate =
    p.aggregateThresholdPaise === undefined ? null : BigInt(p.aggregateThresholdPaise);
  let base: bigint;
  let why: string;

  if (rule.onExcessOnly) {
    const limit = aggregate ?? 0n;
    const over = total > limit ? total - limit : 0n;
    base = over < i.basePaise ? over : i.basePaise;
    why =
      base === 0n
        ? `the year's total is still within the limit`
        : `tax on the part above the limit`;
    trace.push(
      step(
        'tds.excess',
        { total, limit },
        base,
        `${rule.section}: tax only on the part above the limit`,
      ),
    );
  } else {
    const aggregateCrossed = aggregate !== null && total > aggregate;
    const singleCrossed = single !== null && i.basePaise > single;
    if (aggregateCrossed) {
      base = total > i.alreadyBasePaise ? total - i.alreadyBasePaise : 0n;
      why = `the year's total is above the limit, so tax is on everything not yet taxed`;
      trace.push(
        step(
          'tds.aggregate',
          { total, aggregate, alreadyTaxed: i.alreadyBasePaise },
          base,
          `${rule.section}: the year's total crossed the limit, so earlier payments are caught up`,
        ),
      );
    } else if (singleCrossed) {
      base = i.basePaise;
      why = 'this payment is above the single-payment limit';
      trace.push(
        step(
          'tds.single',
          { payment: i.basePaise, single },
          base,
          `${rule.section}: single payment over the limit`,
        ),
      );
    } else {
      base = 0n;
      why = 'under the limit';
      trace.push(
        step(
          'tds.below',
          { total, aggregate, single },
          0,
          `${rule.section}: under the limit, no tax`,
        ),
      );
    }
  }
  if (base === 0n) return nothing(why, trace);

  const panOk = hasPan(i.pan);
  let rateBp = rate;
  if (!panOk) {
    // s.206AA: the higher of the rate and 20%; for 194Q, 5%
    const floor = rule.section === '194Q' ? 500 : data.noPanRateBp;
    rateBp = Math.max(rate, floor);
    trace.push(
      step(
        'tds.no_pan',
        { rate, floor },
        rateBp,
        'no valid PAN: the higher rate of s.206AA applies',
      ),
    );
  }

  const lower = panOk ? lowerPortion(i.lower, i.date, base) : null;
  let taxPaise: bigint;
  if (lower) {
    const covered = tax(lower.covered, lower.rateBp);
    const rest = tax(base - lower.covered, rateBp);
    taxPaise = covered + rest;
    trace.push(
      step(
        'tds.lower_cert',
        { covered: lower.covered, lowerRateBp: lower.rateBp },
        taxPaise,
        'lower deduction certificate (s.197) applies to the covered part',
      ),
    );
  } else {
    taxPaise = tax(base, rateBp);
  }
  trace.push(
    step(
      'tds.tax',
      { base, rateBp },
      taxPaise,
      `${rule.section}: ${rateBp / 100}% of the base, to the nearest rupee`,
    ),
  );
  return {
    applies: taxPaise > 0n,
    basePaise: base,
    rateBp: lower ? lower.rateBp : rateBp,
    taxPaise,
    noPan: !panOk,
    lowerCert: !!lower,
    why,
    trace,
  };
}

export interface TcsInput {
  nature: string;
  date: string;
  /** The amount the tax is on, already with or without GST as the rule says. */
  basePaise: bigint;
  pan: string;
  /** What this buyer has bought this year before this sale (for the sections with a yearly limit). */
  cumulativeBeforePaise: bigint;
}

export function computeTcs(i: TcsInput, data: DirectTaxData = DIRECT_TAX): Deduction {
  const rule = tcsRule(i.nature, data);
  if (!rule) return nothing(`${i.nature} is not something this software collects tax on.`, []);
  const p = periodAt(rule.periods, i.date);
  if (!p || p.rateBp === undefined)
    return nothing(`${rule.section} does not apply on ${i.date}.`, [
      step('tcs.period', { date: i.date }, 0, `${rule.section} is not in force on this date`),
    ]);
  const trace: TraceStep[] = [];
  const total = i.cumulativeBeforePaise + i.basePaise;
  let base = i.basePaise;
  if (p.perTransactionThresholdPaise !== undefined) {
    if (i.basePaise <= BigInt(p.perTransactionThresholdPaise))
      return nothing('under the limit for one sale', [
        step('tcs.single', { sale: i.basePaise }, 0, 'the sale is not above the limit'),
      ]);
  }
  if (rule.onExcessOnly && p.aggregateThresholdPaise !== undefined) {
    const limit = BigInt(p.aggregateThresholdPaise);
    const over = total > limit ? total - limit : 0n;
    base = over < i.basePaise ? over : i.basePaise;
    trace.push(step('tcs.excess', { total, limit }, base, 'tax only on the part above the limit'));
  }
  if (base === 0n) return nothing('the year total is still within the limit', trace);
  const panOk = hasPan(i.pan);
  // s.206CC: twice the rate, or 5%, whichever is higher
  const rateBp = panOk ? p.rateBp : Math.max(p.rateBp * 2, 500);
  if (!panOk)
    trace.push(
      step(
        'tcs.no_pan',
        { rate: p.rateBp },
        rateBp,
        'no valid PAN: the higher rate of s.206CC applies',
      ),
    );
  const taxPaise = tax(base, rateBp);
  trace.push(
    step(
      'tcs.tax',
      { base, rateBp },
      taxPaise,
      `${rule.section}: ${rateBp / 100}% of the base, to the nearest rupee`,
    ),
  );
  return {
    applies: taxPaise > 0n,
    basePaise: base,
    rateBp,
    taxPaise,
    noPan: !panOk,
    lowerCert: false,
    why: 'tax is collected on this sale',
    trace,
  };
}

/** Interest for a late deposit: per month or part, from the day of deduction to the day of deposit. */
export function lateDepositInterest(
  taxPaise: bigint,
  months: number,
  data: DirectTaxData = DIRECT_TAX,
): bigint {
  return divRound(taxPaise * BigInt(data.due.lateDepositInterestBpPerMonth) * BigInt(months), BP);
}

/** Interest for tax deducted late: per month or part, from the day it was due to the day it was deducted. */
export function lateDeductionInterest(
  taxPaise: bigint,
  months: number,
  data: DirectTaxData = DIRECT_TAX,
): bigint {
  return divRound(taxPaise * BigInt(data.due.lateDeductionInterestBpPerMonth) * BigInt(months), BP);
}
