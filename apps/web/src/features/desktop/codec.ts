/**
 * How database values cross the bridge to the desktop's Rust connection, which speaks JSON. Most values
 * are what they look like. A bigint is `{ $int: "123" }` (JSON has no bigint and a JavaScript number
 * loses digits past 2^53), and bytes are `{ $blob: "<base64>" }`. The same shapes come back.
 */
export type Wire = null | boolean | number | string | { $int: string } | { $blob: string };

const SAFE = Number.MAX_SAFE_INTEGER;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A parameter as the bridge wants it. */
export function encode(v: unknown): Wire {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return { $int: v.toString() };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('a non-finite number cannot be stored');
    // a whole number past 2^53 is already inexact; send it as the integer it was meant to be
    return Number.isInteger(v) && Math.abs(v) > SAFE ? { $int: BigInt(v).toString() } : v;
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return { $blob: toBase64(v) };
  if (v instanceof ArrayBuffer) return { $blob: toBase64(new Uint8Array(v)) };
  if (v instanceof Date) return v.getTime();
  throw new Error(`cannot store a value of type ${typeof v}`);
}

/** A value from the bridge, as the browser's SQLite gives it: a number (a bigint past 2^53), text, bytes or null. */
export function decode(v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['$int'] === 'string') return BigInt(o['$int']);
    if (typeof o['$blob'] === 'string') return fromBase64(o['$blob']);
  }
  return v;
}
