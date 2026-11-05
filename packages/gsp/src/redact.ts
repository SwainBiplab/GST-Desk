/**
 * Every request and response is kept for audit, with anything that would let someone act as the
 * business taken out first. This is the one place that decides what counts as a secret.
 */
// not `pin`: the payloads carry pincodes (`Pin`), which belong in the record
const SECRET_KEY = /pass(word)?|secret|token|^sek$|app_?key|otp|credential/i;

export const REMOVED = '[removed]';

/** A deep copy with every secret-looking field replaced. Strings are left as they are. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REMOVED : redact(v);
    }
    return out as T;
  }
  return value;
}
