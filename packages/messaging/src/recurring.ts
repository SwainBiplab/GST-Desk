/** When a recurring invoice next runs (prompt 44, FR-038). Dates are Indian calendar dates. */
import { addDays } from './time';

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Schedule {
  frequency: Frequency;
  /** Every n weeks, months, quarters or years. */
  every: number;
  /** For monthly and longer: the day of the month (1 to 31); a short month uses its last day. */
  dayOfMonth: number;
}

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The run after `from` (exclusive), on the schedule. */
export function nextRun(from: string, s: Schedule): string {
  if (s.frequency === 'weekly') return addDays(from, 7 * s.every);
  const months =
    s.frequency === 'monthly' ? s.every : s.frequency === 'quarterly' ? 3 * s.every : 12 * s.every;
  const [y, m] = from.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(s.dayOfMonth, daysIn(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first run on or after `start`: the day itself when it fits, else the next on the schedule. */
export function firstRun(start: string, s: Schedule): string {
  if (s.frequency === 'weekly') return start;
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const day = Math.min(s.dayOfMonth, daysIn(y, m));
  if (day >= d) return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return nextRun(start, { ...s, frequency: 'monthly', every: 1 });
}

/** Every date the schedule is due up to and including `today`, from `next` (a catch-up after an outage). */
export function dueDates(next: string, today: string, s: Schedule, max = 12): string[] {
  const out: string[] = [];
  let at = next;
  while (at <= today && out.length < max) {
    out.push(at);
    at = nextRun(at, s);
  }
  return out;
}
