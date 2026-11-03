/** Only formatters allowed in UI. Money is integer paise; never floats. */

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Format an integer (or numeric string) with lakh/crore grouping: 123456 -> "1,23,456". */
export function formatIndianNumber(value: number | bigint | string, fractionDigits = 0): string {
  const raw = typeof value === 'string' ? value.trim() : String(value);
  const negative = raw.startsWith('-');
  const [intPart = '0', fracPart = ''] = raw.replace(/^[-+]/, '').split('.');
  const frac = fracPart.padEnd(fractionDigits, '0').slice(0, fractionDigits);
  const grouped = groupIndian(intPart.replace(/^0+(?=\d)/, '') || '0');
  const body = fractionDigits > 0 ? `${grouped}.${frac}` : grouped;
  const isZero = /^[0,.]*$/.test(body);
  return negative && !isZero ? `-${body}` : body;
}

export interface FormatPaiseOptions {
  currency?: 'INR';
  locale?: 'en-IN';
  /** Show the currency symbol (default true). */
  symbol?: boolean;
}

/** Format integer paise as rupees: 12345600 -> "₹1,23,456.00". */
export function formatPaise(paise: number | bigint, options: FormatPaiseOptions = {}): string {
  const { symbol = true } = options;
  const n = BigInt(paise);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const rupees = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  const body = `${groupIndian(rupees.toString())}.${frac}`;
  const out = symbol ? `₹${body}` : body;
  return negative ? `-${out}` : out;
}

/** Parse user text like "1,23,456.5" to integer paise; returns null when invalid. */
export function parsePaise(input: string): bigint | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m || (m[2] === '' && !m[3])) return null;
  const paise = BigInt(m[2] || '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -paise : paise;
}

/** Basis points to percent text: 1800 -> "18%", 250 -> "2.5%". */
export function formatBasisPoints(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`;
}

/** Dates in Indian format dd-MM-yyyy. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}
