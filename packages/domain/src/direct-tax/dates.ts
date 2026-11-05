/** Quarters, due dates and "month or part of a month" for TDS and TCS. Dates are ISO strings; no clock. */
import { parseIso, toIso } from '../fy';

import { DIRECT_TAX, type DirectTaxData } from './data';

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];

export interface TaxQuarter {
  /** `2025-26`. */
  fy: string;
  fyStartYear: number;
  quarter: Quarter;
  from: string;
  to: string;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const fyLabelOf = (startYear: number): string =>
  `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** The start year of a `2025-26` label. */
export function fyStartYear(fy: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) throw new RangeError(`not a financial year: "${fy}"`);
  return Number(m[1]);
}

/** The financial year (April to March) a date falls in, as a `2025-26` label. */
export function fyOfDate(date: string): string {
  const { y, m } = parseIso(date);
  return fyLabelOf(m >= 4 ? y : y - 1);
}

export function quarterOf(date: string): TaxQuarter {
  const { y, m } = parseIso(date);
  const start = m >= 4 ? y : y - 1;
  const idx = m >= 4 ? Math.floor((m - 4) / 3) : 3;
  const q = QUARTERS[idx]!;
  return quarterOfFy(fyLabelOf(start), q);
}

export function quarterOfFy(fy: string, quarter: Quarter): TaxQuarter {
  const s = fyStartYear(fy);
  const idx = QUARTERS.indexOf(quarter);
  const firstMonth = 4 + idx * 3;
  const year = firstMonth > 12 ? s + 1 : s;
  const m1 = firstMonth > 12 ? firstMonth - 12 : firstMonth;
  const lastM = m1 + 2;
  return {
    fy,
    fyStartYear: s,
    quarter,
    from: toIso(year, m1, 1),
    to: toIso(year, lastM, lastDay(year, lastM)),
  };
}

export function quartersOfFy(fy: string): TaxQuarter[] {
  return QUARTERS.map((q) => quarterOfFy(fy, q));
}

/** The day by which tax deducted or collected on `date` must be deposited. */
export function depositDueDate(date: string, data: DirectTaxData = DIRECT_TAX): string {
  const { y, m } = parseIso(date);
  if (m === 3) return `${y}-${data.due.marchDeposit}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return toIso(ny, nm, data.due.depositDay);
}

/** The day the quarter's statement (26Q or 27EQ) is due. */
export function returnDueDate(q: TaxQuarter, data: DirectTaxData = DIRECT_TAX): string {
  const md = data.due.returnDates[q.quarter];
  const month = Number(md.slice(0, 2));
  // the Q3 and Q4 statements fall in the calendar year after the quarter starts
  const year =
    q.quarter === 'Q4' ? q.fyStartYear + 1 : month <= 3 ? q.fyStartYear + 1 : q.fyStartYear;
  return `${year}-${md}`;
}

/**
 * Months between two dates, counting a part of a month as a whole month (the way interest on late
 * deduction and late deposit is charged). Zero when `to` is not after `from`.
 */
export function monthsOrPart(from: string, to: string): number {
  if (to <= from) return 0;
  const a = parseIso(from);
  const b = parseIso(to);
  const whole = (b.y - a.y) * 12 + (b.m - a.m);
  return whole + (b.d > a.d ? 1 : 0);
}
