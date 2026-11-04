/**
 * Money primitives. All amounts are integer paise held in `bigint`; there is no floating point
 * anywhere on the money path. Quantities are integer micro-units (1_000_000 = 1 unit).
 */

export type Paise = bigint & { readonly __brand: 'Paise' };

export const MICROS = 1_000_000n;
export const BP = 10_000n;
export const ZERO = 0n;

/** Brand an integer as paise. Rejects non-integers so fractions never sneak in. */
export function paise(v: bigint | number | string): Paise {
  if (typeof v === 'bigint') return v as Paise;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new RangeError(`paise must be a safe integer, got ${v}`);
    return BigInt(v) as Paise;
  }
  if (!/^-?\d+$/.test(v.trim()))
    throw new RangeError(`paise must be an integer string, got "${v}"`);
  return BigInt(v.trim()) as Paise;
}

/** Round-half-away-from-zero integer division. The only rounding rule used for money. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return negative ? -q : q;
}

/** round(a * b / d) with a single rounding step. */
export function mulDivRound(a: bigint, b: bigint, d: bigint): bigint {
  return divRound(a * b, d);
}

/** Round to the nearest whole rupee (100 paise), halves away from zero. */
export function roundToRupee(p: bigint): bigint {
  return divRound(p, 100n) * 100n;
}

export function sum(xs: readonly bigint[]): bigint {
  let s = 0n;
  for (const x of xs) s += x;
  return s;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Split `total` across `weights` proportionally using the largest-remainder method, so the parts
 * add up to `total` exactly. Ties go to the earlier index. Works for negative totals.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => (x < 0n ? -x : x));
  const sumW = sum(w);
  if (total === 0n) return weights.map(() => 0n);
  if (sumW === 0n) throw new RangeError('cannot allocate across zero total weight');
  const sign = total < 0n ? -1n : 1n;
  const abs = total < 0n ? -total : total;
  const shares = w.map((x) => (abs * x) / sumW);
  const rems = w.map((x, i) => ({ i, r: (abs * x) % sumW }));
  let left = abs - sum(shares);
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rems) {
    if (left === 0n) break;
    shares[i]! += 1n;
    left -= 1n;
  }
  return shares.map((s) => s * sign);
}

/** Parse a plain decimal string ("2.5", "-0.125") to an integer scaled by 10^scale, rounding half away. */
export function parseScaled(text: string, scale: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a decimal number: "${text}"`);
  const frac = m[3] ?? '';
  const base = 10n ** BigInt(scale);
  let n = BigInt(m[2]!) * base;
  if (frac.length <= scale) {
    n += BigInt(frac.padEnd(scale, '0') || '0');
  } else {
    n += BigInt(frac.slice(0, scale));
    if (frac.charCodeAt(scale) >= 53) n += 1n; // '5' or above rounds up
  }
  return m[1] ? -n : n;
}

/** "2.5" -> 2_500_000n (micro-units). */
export function qty(text: string | number): bigint {
  return parseScaled(String(text), 6);
}

/** "1234.5" rupees -> 123450n paise. */
export function rupees(text: string | number): Paise {
  return parseScaled(String(text), 2) as Paise;
}

/** Display helper: 12345600n -> "123456.00" (no grouping, no symbol). */
export function toDecimalString(p: bigint, scale = 2): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const s = abs.toString().padStart(scale + 1, '0');
  const body = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return neg ? `-${body}` : body;
}
