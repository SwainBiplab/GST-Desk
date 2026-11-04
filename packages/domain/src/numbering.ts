/**
 * Document numbering. Rule 46(b) CGST Rules: a consecutive serial number of at most 16 characters,
 * in one or multiple series, containing only alphabets, numerals, hyphen and slash.
 */
import { fyOf, parseIso } from './fy';

export const MAX_NUMBER_LENGTH = 16;
const ALLOWED = /^[A-Za-z0-9/-]+$/;

export class NumberingError extends Error {
  override name = 'NumberingError';
}

export interface SeriesSpec {
  /** May contain `{FY}` (25-26), `{YYYY}` and `{MM}` tokens. */
  prefix: string;
  suffix: string;
  padding: number;
  reset: 'fy' | 'never';
}

/** Replace `{FY}`, `{YYYY}`, `{MM}` using the document date. */
export function renderAffix(template: string, date: string, fyStartMonth = 4): string {
  const { y, m } = parseIso(date);
  return template
    .replaceAll('{FY}', fyOf(date, fyStartMonth).label)
    .replaceAll('{YYYY}', String(y).padStart(4, '0'))
    .replaceAll('{MM}', String(m).padStart(2, '0'));
}

export function validateDocumentNumber(n: string): string[] {
  const errors: string[] = [];
  if (n.length === 0) errors.push('number is empty');
  if (n.length > MAX_NUMBER_LENGTH) {
    errors.push(`number is ${n.length} characters; the limit is ${MAX_NUMBER_LENGTH}`);
  }
  if (n.length > 0 && !ALLOWED.test(n))
    errors.push('only A-Z, a-z, 0-9, hyphen and slash are allowed');
  return errors;
}

/** `{prefix}{number padded}{suffix}`; throws if the result breaks the GST format rule. */
export function formatDocumentNumber(
  spec: SeriesSpec,
  number: number,
  date: string,
  fyStartMonth = 4,
): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new NumberingError('number must be a positive integer');
  }
  const out =
    renderAffix(spec.prefix, date, fyStartMonth) +
    String(number).padStart(spec.padding, '0') +
    renderAffix(spec.suffix, date, fyStartMonth);
  const errors = validateDocumentNumber(out);
  if (errors.length > 0) throw new NumberingError(`"${out}": ${errors.join('; ')}`);
  return out;
}

export interface SeriesState {
  next: number;
  /** FY label the counter currently belongs to (null before first use). */
  fy: string | null;
}

/** Should the counter restart for a document on `date`? */
export function needsReset(
  spec: SeriesSpec,
  state: SeriesState,
  date: string,
  fyStartMonth = 4,
): boolean {
  return spec.reset === 'fy' && state.fy !== null && state.fy !== fyOf(date, fyStartMonth).label;
}

/** Take the next number, restarting at 1 on a new financial year when the series resets by FY. */
export function takeNext(
  spec: SeriesSpec,
  state: SeriesState,
  date: string,
  fyStartMonth = 4,
): { number: string; state: SeriesState } {
  const label = fyOf(date, fyStartMonth).label;
  const base = needsReset(spec, state, date, fyStartMonth) ? 1 : state.next;
  return {
    number: formatDocumentNumber(spec, base, date, fyStartMonth),
    state: { next: base + 1, fy: spec.reset === 'fy' ? label : (state.fy ?? label) },
  };
}

/* ------------------------------------------------------------------ multi-device reservations */

export interface Range {
  /** Inclusive. */
  from: number;
  to: number;
}

export interface Reservation extends Range {
  /** How many numbers have been consumed from the start of the range. */
  used: number;
}

export interface Pool {
  next: number;
  /** Ranges handed back by devices; reused (lowest first) before `next` advances. */
  released: Range[];
}

const size = (r: Range) => r.to - r.from + 1;

export function remaining(r: Reservation): number {
  return size(r) - r.used;
}

/** Reserve `n` consecutive numbers for a device. */
export function reserve(pool: Pool, n: number): { pool: Pool; reservation: Reservation } {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new NumberingError('reservation size must be a positive integer');
  }
  const released = [...pool.released].sort((a, b) => a.from - b.from);
  const i = released.findIndex((r) => size(r) >= n);
  if (i >= 0) {
    const r = released[i]!;
    const taken = { from: r.from, to: r.from + n - 1 };
    if (size(r) === n) released.splice(i, 1);
    else released[i] = { from: r.from + n, to: r.to };
    return { pool: { next: pool.next, released }, reservation: { ...taken, used: 0 } };
  }
  return {
    pool: { next: pool.next + n, released },
    reservation: { from: pool.next, to: pool.next + n - 1, used: 0 },
  };
}

/** Use the next number from a device's range. Throws when the range is exhausted. */
export function consume(r: Reservation): { number: number; reservation: Reservation } {
  if (remaining(r) <= 0) throw new NumberingError(`reservation ${r.from}-${r.to} is exhausted`);
  return { number: r.from + r.used, reservation: { ...r, used: r.used + 1 } };
}

/** Return unused numbers to the pool. Used numbers stay consumed. */
export function release(pool: Pool, r: Reservation): Pool {
  if (remaining(r) <= 0) return pool;
  const back: Range = { from: r.from + r.used, to: r.to };
  // the tail of the pool can simply shrink back
  if (back.to + 1 === pool.next) return { next: back.from, released: pool.released };
  return { next: pool.next, released: [...pool.released, back] };
}
