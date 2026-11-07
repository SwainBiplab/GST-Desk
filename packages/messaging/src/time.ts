/** India has one time zone and no daylight saving: dates and quiet hours are read in IST. */
const IST_MS = (5 * 60 + 30) * 60_000;

/** `YYYY-MM-DD` in India at an instant. */
export const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** Minutes since midnight in India at an instant. */
export const istMinutes = (ms: number): number => {
  const d = new Date(ms + IST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** The instant of `HH:MM` on an Indian date. */
export const istInstant = (date: string, hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - IST_MS;
};

export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface QuietHours {
  /** `HH:MM`; the window may cross midnight (21:00 to 09:00). */
  start: string;
  end: string;
}

export const DEFAULT_QUIET: QuietHours = { start: '21:00', end: '09:00' };

const minutesOf = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function inQuietHours(ms: number, q: QuietHours): boolean {
  const now = istMinutes(ms);
  const a = minutesOf(q.start);
  const b = minutesOf(q.end);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

/** The first moment at or after `ms` that is not quiet. */
export function afterQuiet(ms: number, q: QuietHours): number {
  if (!inQuietHours(ms, q)) return ms;
  const today = istDate(ms);
  const end = istInstant(today, q.end);
  return end > ms ? end : istInstant(addDays(today, 1), q.end);
}
