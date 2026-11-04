/**
 * Mask personal identifiers before text leaves the device. The mapping lives in memory for the
 * lifetime of one `Redaction` and is never persisted or logged.
 */

export type RedactKind = 'PAN' | 'ACCOUNT' | 'AADHAAR' | 'PHONE';

export interface RedactOptions {
  /** Also mask Indian mobile numbers (off by default: names and phones are often the point). */
  phones?: boolean;
}

export interface Redaction {
  text: string;
  /** Put the original values back into text that came back from the provider. */
  restore(text: string): string;
  /** Number of masked values per kind. */
  counts: Record<RedactKind, number>;
}

/* ------------------------------------------------------------------ Verhoeff (Aadhaar check digit) */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True when the digit string (check digit last) passes Verhoeff. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = [...digits].reverse();
  rev.forEach((ch, i) => {
    c = D[c]![P[i % 8]![Number(ch)]!]!;
  });
  return c === 0;
}

/** Append the Verhoeff check digit (used by tests to build valid Aadhaar-shaped numbers). */
export function verhoeffAppend(base: string): string {
  let c = 0;
  [...base].reverse().forEach((ch, i) => {
    c = D[c]![P[(i + 1) % 8]![Number(ch)]!]!;
  });
  return base + String(INV[c]);
}

/* ------------------------------------------------------------------ patterns */

const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
const DIGIT_RUN = /(?<![\d-])\d{9,18}(?![\d-])/g;
const AADHAAR = /(?<!\d)[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?!\d)/g;
const PHONE = /(?<!\d)(?:\+91[ -]?|0)?[6-9]\d{9}(?!\d)/g;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const ACCOUNT_WORDS = /a\/c|acct|account|a\.c\.|bank|ifsc|savings|current/i;

function nearAccountContext(text: string, start: number, end: number): boolean {
  // Look 30 characters either side, but stop at another long number so that
  // "a/c 1234567890, Aadhaar 2345..." does not make the Aadhaar look like an account.
  const before = text.slice(Math.max(0, start - 30), start);
  const after = text.slice(end, Math.min(text.length, end + 30));
  const lastRun = [...before.matchAll(/(?<![A-Za-z0-9])\d{6,}/g)].pop();
  const firstRun = /(?<![A-Za-z0-9])\d{6,}/.exec(after);
  const near =
    (lastRun ? before.slice(lastRun.index + lastRun[0].length) : before) +
    ' ' +
    (firstRun ? after.slice(0, firstRun.index) : after);
  return ACCOUNT_WORDS.test(near) || IFSC.test(near);
}

/** Mask PAN, bank account numbers, Aadhaar (checksum-validated) and optionally phone numbers. */
export function redact(input: string, opts: RedactOptions = {}): Redaction {
  const map = new Map<string, string>();
  const counts: Record<RedactKind, number> = { PAN: 0, ACCOUNT: 0, AADHAAR: 0, PHONE: 0 };
  const mask = (kind: RedactKind, value: string): string => {
    counts[kind] += 1;
    const token = `[${kind}_${counts[kind]}]`;
    map.set(token, value);
    return token;
  };

  let text = input.replace(PAN, (m) => mask('PAN', m));

  text = text.replace(DIGIT_RUN, (m, offset: number, whole: string) =>
    nearAccountContext(whole, offset, offset + m.length) ? mask('ACCOUNT', m) : m,
  );

  text = text.replace(AADHAAR, (m) =>
    verhoeffValid(m.replace(/[ -]/g, '')) ? mask('AADHAAR', m) : m,
  );

  if (opts.phones) text = text.replace(PHONE, (m) => mask('PHONE', m));

  return {
    text,
    counts,
    restore: (s) => s.replace(/\[(?:PAN|ACCOUNT|AADHAAR|PHONE)_\d+\]/g, (t) => map.get(t) ?? t),
  };
}
