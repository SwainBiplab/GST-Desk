/**
 * Document numbers as suppliers actually write them. The same invoice can be `INV/0012`, `inv-12`,
 * `2025-26/INV/12` or just `12` in different places; these helpers make them comparable.
 */

/**
 * The comparison key of a number: letters and digits only, upper case, and the digits of each part
 * (the stretches between slashes, dashes and spaces) stripped of leading zeros. So `INV/0012` and
 * `inv-12` are the same, `GST/2025-26/00045` is `GST/2025-26/45`, and `0` stays `0`. Zeros are stripped
 * per part because suppliers pad the running number, not the year in front of it.
 */
export function numberKey(n: string): string {
  return n
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, '')))
    .join('');
}

export interface NumberParts {
  /** What comes before the last run of digits, as a key. */
  prefix: string;
  /** The last run of digits without leading zeros, empty when there are none. */
  tail: string;
}

export function numberParts(n: string): NumberParts {
  const key = numberKey(n);
  const m = /^(.*?)(\d+)([A-Z]*)$/.exec(key);
  if (!m) return { prefix: key, tail: '' };
  return { prefix: m[1]! + (m[3] ?? ''), tail: m[2]! };
}

/**
 * Whether two numbers can be the same document written differently: the same last run of digits, and
 * prefixes that agree, or one of which is missing or is the end or the start of the other (a financial
 * year, a branch code, a series letter added or dropped). Never true for numbers without digits.
 */
export function numbersAlike(a: string, b: string): boolean {
  if (numberKey(a) === numberKey(b)) return true;
  const x = numberParts(a);
  const y = numberParts(b);
  if (!x.tail || x.tail !== y.tail) return false;
  if (x.prefix === y.prefix || !x.prefix || !y.prefix) return true;
  return (
    x.prefix.endsWith(y.prefix) ||
    y.prefix.endsWith(x.prefix) ||
    x.prefix.startsWith(y.prefix) ||
    y.prefix.startsWith(x.prefix)
  );
}

/** Days between two ISO dates (b minus a). */
export function daysApart(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export const normGstin = (g: string): string => g.trim().toUpperCase();
