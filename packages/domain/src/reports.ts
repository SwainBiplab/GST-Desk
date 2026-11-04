/**
 * Pure helpers behind reports and dashboards (prompt 18): period presets in the Indian financial
 * year, ageing buckets, and the filing calendar. Dates are ISO `YYYY-MM-DD`; the clock is injected.
 */
import { addDays } from './documents/rules';
import { financialYear, fyOf, parseIso, toIso } from './fy';
import { daysBetween } from './party-account';

/* ------------------------------------------------------------------ periods */

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_fy',
  'last_fy',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface Period {
  from: string;
  to: string;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function monthPeriod(y: number, m: number): Period {
  return { from: toIso(y, m, 1), to: toIso(y, m, lastDay(y, m)) };
}

/** Month `m` of year `y` moved by `by` months. */
function shiftMonth(y: number, m: number, by: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + by;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/**
 * The dates a preset stands for on `today`. Quarters follow the financial year (Apr to Jun is Q1), so
 * "this quarter" is the GST quarter a QRMP filer files for.
 */
export function resolvePeriod(preset: PeriodPreset, today: string, fyStartMonth = 4): Period {
  const { y, m } = parseIso(today);
  switch (preset) {
    case 'today':
    case 'custom':
      return { from: today, to: today };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case 'this_month':
      return monthPeriod(y, m);
    case 'last_month': {
      const p = shiftMonth(y, m, -1);
      return monthPeriod(p.y, p.m);
    }
    case 'this_quarter':
    case 'last_quarter': {
      const offset = (m - fyStartMonth + 12) % 12;
      const quarterStart = shiftMonth(y, m, -(offset % 3) - (preset === 'last_quarter' ? 3 : 0));
      const end = shiftMonth(quarterStart.y, quarterStart.m, 2);
      return {
        from: toIso(quarterStart.y, quarterStart.m, 1),
        to: toIso(end.y, end.m, lastDay(end.y, end.m)),
      };
    }
    case 'this_fy': {
      const fy = fyOf(today, fyStartMonth);
      return { from: fy.start, to: fy.end };
    }
    case 'last_fy': {
      const fy = financialYear(fyOf(today, fyStartMonth).startYear - 1, fyStartMonth);
      return { from: fy.start, to: fy.end };
    }
  }
}

/** The preset that `period` equals on `today`, or `custom`. */
export function presetOf(period: Period, today: string, fyStartMonth = 4): PeriodPreset {
  for (const p of PERIOD_PRESETS) {
    if (p === 'custom') continue;
    const r = resolvePeriod(p, today, fyStartMonth);
    if (r.from === period.from && r.to === period.to) return p;
  }
  return 'custom';
}

/** The same dates one month earlier, clipped to that month (1 to 31 Mar becomes 1 to 28 Feb). */
export function sameDaysLastMonth(period: Period): Period {
  const f = parseIso(period.from);
  const t = parseIso(period.to);
  const a = shiftMonth(f.y, f.m, -1);
  const b = shiftMonth(t.y, t.m, -1);
  return {
    from: toIso(a.y, a.m, Math.min(f.d, lastDay(a.y, a.m))),
    to: toIso(b.y, b.m, Math.min(t.d, lastDay(b.y, b.m))),
  };
}

/* ------------------------------------------------------------------ ageing */

export const AGEING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days past due. A document with no due date is aged from its own date. Not yet due is 0 or less. */
export function daysPastDue(dueDate: string | null, docDate: string, today: string): number {
  return daysBetween(dueDate ?? docDate, today);
}

export function ageingBucket(daysOverdue: number): AgeingBucket {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

export type AgeingRow = Record<AgeingBucket, bigint>;
export const emptyAgeing = (): AgeingRow => ({
  notDue: 0n,
  d1_30: 0n,
  d31_60: 0n,
  d61_90: 0n,
  d90plus: 0n,
});

/** Add a balance to the bucket its due date falls in. */
export function ageInto(
  row: AgeingRow,
  balancePaise: bigint,
  dueDate: string | null,
  docDate: string,
  today: string,
): void {
  row[ageingBucket(daysPastDue(dueDate, docDate, today))] += balancePaise;
}

/* ------------------------------------------------------------------ filing calendar */

export interface FilingDue {
  form: 'gstr1' | 'gstr3b';
  /** The month the return is for, `YYYY-MM`. */
  period: string;
  due: string;
  /** Days from today; negative when late. */
  inDays: number;
}

/**
 * The static calendar until the Filing Desk (P2): for monthly filers GSTR-1 is due on the 11th and
 * GSTR-3B on the 20th of the month after the return month. Extensions the government announces are
 * not known here, so the screen calls them the usual dates. Returns the next dates, soonest first,
 * and keeps a return up to ten days late so a missed one is not hidden.
 */
export function filingCalendar(today: string): FilingDue[] {
  const { y, m } = parseIso(today);
  const out: FilingDue[] = [];
  for (const back of [1, 0]) {
    const ret = shiftMonth(y, m, -back);
    const due = shiftMonth(ret.y, ret.m, 1);
    for (const [form, day] of [
      ['gstr1', 11],
      ['gstr3b', 20],
    ] as const) {
      const date = toIso(due.y, due.m, day);
      out.push({
        form,
        period: `${ret.y}-${String(ret.m).padStart(2, '0')}`,
        due: date,
        inDays: daysBetween(today, date),
      });
    }
  }
  return out.filter((f) => f.inDays >= -10).sort((a, b) => a.due.localeCompare(b.due));
}
