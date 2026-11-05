import { describe, expect, it } from 'vitest';

import { decode, encode, fromBase64, toBase64 } from './codec';

describe('values across the desktop bridge', () => {
  it('sends ordinary values as they are', () => {
    expect(encode(null)).toBeNull();
    expect(encode(undefined)).toBeNull();
    expect(encode(true)).toBe(true);
    expect(encode(12345)).toBe(12345);
    expect(encode(1.5)).toBe(1.5);
    expect(encode('text')).toBe('text');
    expect(encode(new Date(1_700_000_000_000))).toBe(1_700_000_000_000);
  });

  it('sends a bigint, and a number too big to be exact, as an integer string', () => {
    expect(encode(9_223_372_036_854_775_807n)).toEqual({ $int: '9223372036854775807' });
    expect(encode(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(encode(2 ** 60)).toEqual({ $int: (2n ** 60n).toString() });
  });

  it('sends bytes as base64 and gets them back', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const wire = encode(bytes) as { $blob: string };
    expect(wire.$blob).toBe(toBase64(bytes));
    expect(decode(wire)).toEqual(bytes);
    expect(fromBase64(toBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('handles bytes larger than one chunk', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });

  it('reads integers, blobs and plain values coming back', () => {
    expect(decode({ $int: '9223372036854775807' })).toBe(9_223_372_036_854_775_807n);
    expect(decode(42)).toBe(42);
    expect(decode('x')).toBe('x');
    expect(decode(null)).toBeNull();
    expect(decode({ other: 1 })).toEqual({ other: 1 });
  });

  it('refuses what cannot be stored', () => {
    expect(() => encode(Number.NaN)).toThrow();
    expect(() => encode(Infinity)).toThrow();
    expect(() => encode({})).toThrow();
    expect(() => encode(() => 1)).toThrow();
  });
});
