/** Financial-year helpers. Dates are ISO `YYYY-MM-DD` strings; the clock is always injected. */

export type Clock = () => Date;

export interface FinancialYear {
  startYear: number;
  /** `25-26` (or `2025` when the year starts in January). */
  label: string;
  /** First day, ISO. */
  start: string;
  /** Last day, ISO. */
  end: string;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIso(date: string): { y: number; m: number; d: number } {
  const m = ISO.exec(date);
  if (!m) throw new RangeError(`not an ISO date: "${date}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days) throw new RangeError(`not a valid date: "${date}"`);
  return { y, m: mo, d };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const toIso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** Today's date in India (UTC+05:30) from an injected clock. */
export function today(clock: Clock): string {
  const ist = new Date(clock().getTime() + 330 * 60_000);
  return toIso(ist.getUTCFullYear(), ist.getUTCMonth() + 1, ist.getUTCDate());
}

export function financialYear(startYear: number, startMonth = 4): FinancialYear {
  if (startMonth < 1 || startMonth > 12) throw new RangeError('fy start month must be 1-12');
  const start = toIso(startYear, startMonth, 1);
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const end = toIso(endYear, endMonth, new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate());
  const label =
    startMonth === 1 ? pad(startYear, 4) : `${pad(startYear % 100)}-${pad((startYear + 1) % 100)}`;
  return { startYear, label, start, end };
}

/** The financial year containing `date`. */
export function fyOf(date: string, startMonth = 4): FinancialYear {
  const { y, m } = parseIso(date);
  return financialYear(m >= startMonth ? y : y - 1, startMonth);
}

export function sameFy(a: string, b: string, startMonth = 4): boolean {
  return fyOf(a, startMonth).startYear === fyOf(b, startMonth).startYear;
}
