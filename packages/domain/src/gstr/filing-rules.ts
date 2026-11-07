/**
 * What the Filing Desk adds around the returns (prompt 46): the late fee a return may attract, the nil return, and
 * QRMP's monthly invoice furnishing facility. Pure functions over dates and paise; nothing reads the clock.
 *
 * **These are estimates.** The rates and caps below are the ones in force when this was written, from the CGST Act
 * s.47 and the notifications that reduce it, typed in by hand and not yet reviewed by the chartered accountant
 * (see `docs/compliance/filing-rules-review.md`). They do not include interest on tax paid late. A screen must
 * call the figure an estimate and name the rule version.
 */
import { addDaysIso } from './period';
import type { GstrPeriod } from './types';

type Json = Record<string, unknown>;

export const FILING_RULES_VERSION = 'late-fee-v1 (unreviewed)';

/** Per day, CGST and SGST together, in paise. */
export const LATE_FEE_PER_DAY_PAISE = 5_000n;
export const LATE_FEE_PER_DAY_NIL_PAISE = 2_000n;

/** The most a single return can attract, by the previous year's aggregate turnover, in paise. */
const RUPEE = 100n;
const CRORE = 10_000_000n * RUPEE;
export const LATE_FEE_CAPS = {
  nil: 500n * RUPEE,
  upTo1_5Cr: 2_000n * RUPEE,
  upTo5Cr: 5_000n * RUPEE,
  above5Cr: 10_000n * RUPEE,
} as const;

export interface LateFeeInput {
  /** The due date of the return (YYYY-MM-DD). */
  due: string;
  /** The day it was filed, or today when it is not filed yet. */
  on: string;
  nil: boolean;
  /** Aggregate turnover of the previous financial year, in paise; unknown means the highest cap applies. */
  turnoverPaise?: bigint | null;
}

export interface LateFee {
  /** Whole days after the due date; 0 when on time. */
  days: number;
  perDayPaise: bigint;
  capPaise: bigint;
  feePaise: bigint;
  /** The cap was reached. */
  capped: boolean;
  version: string;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

export function lateFee(i: LateFeeInput): LateFee {
  const days = Math.max(0, dayNumber(i.on) - dayNumber(i.due));
  const perDay = i.nil ? LATE_FEE_PER_DAY_NIL_PAISE : LATE_FEE_PER_DAY_PAISE;
  const t = i.turnoverPaise ?? null;
  const cap = i.nil
    ? LATE_FEE_CAPS.nil
    : t === null || t > 5n * CRORE
      ? LATE_FEE_CAPS.above5Cr
      : t > (3n * CRORE) / 2n
        ? LATE_FEE_CAPS.upTo5Cr
        : LATE_FEE_CAPS.upTo1_5Cr;
  const raw = perDay * BigInt(days);
  const fee = raw > cap ? cap : raw;
  return {
    days,
    perDayPaise: perDay,
    capPaise: cap,
    feePaise: fee,
    capped: raw > cap,
    version: FILING_RULES_VERSION,
  };
}

/* ------------------------------------------------------------------------------------------ nil return */

/** A GSTR-1 for a period with nothing to report: the file the portal takes for a nil return. */
export function nilGstr1Json(period: GstrPeriod): Json {
  return { gstin: period.gstin, fp: period.fp, nil_return: true };
}

/** A return is nil when no outward document of any kind falls in the period. */
export const isNilPeriod = (outwardDocuments: number): boolean => outwardDocuments === 0;

/* ------------------------------------------------------------------------------------------------ QRMP */

/**
 * Quarterly filers (QRMP) may furnish B2B invoices and credit notes monthly in the first two months of the
 * quarter (IFF), so the buyer's input credit appears sooner; the third month goes in the quarterly GSTR-1.
 * Returns the month periods for which IFF is allowed in a quarter, with the date it is due (13th of the next month).
 */
export function iffMonths(
  quarter: GstrPeriod,
): { fp: string; from: string; to: string; due: string }[] {
  if (quarter.kind !== 'quarter') return [];
  const out: { fp: string; from: string; to: string; due: string }[] = [];
  let from = quarter.from;
  for (let m = 0; m < 2; m++) {
    const next = addDaysIso(`${from.slice(0, 7)}-28`, 4).slice(0, 7); // the following month
    const to = addDaysIso(`${next}-01`, -1);
    out.push({ fp: `${from.slice(5, 7)}${from.slice(0, 4)}`, from, to, due: `${next}-13` });
    from = `${next}-01`;
  }
  return out;
}

/** The IFF file is the GSTR-1 file with only the tables IFF takes (B2B invoices and credit/debit notes to registered buyers). */
export function iffJson(gstr1: Json): Json {
  const out: Json = { gstin: gstr1['gstin'], fp: gstr1['fp'] };
  for (const k of ['b2b', 'cdnr'] as const) if (gstr1[k]) out[k] = gstr1[k];
  return out;
}

/** The most IFF may carry in one month (₹50 lakh of taxable value). */
export const IFF_MONTHLY_LIMIT_PAISE = 5_000_000n * RUPEE;
