/**
 * Indian formats: dates as dd-MM-yyyy, lakh and crore grouping, the rupee sign without a space, and
 * financial years written 2025-26. They do not change with the language of the screen: an Indian
 * business reads the same date and the same amount whether the words around them are Tamil or English.
 */

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** `2026-05-01` (or a Date) to `01-05-2026`. Anything that is not a date comes back as it was. */
export function formatDateIN(value: string | Date): string {
  if (value instanceof Date) {
    return `${pad(value.getDate())}-${pad(value.getMonth() + 1)}-${value.getFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
}

/** `01-05-2026` to `2026-05-01`; null when it is not a real date. */
export function parseDateIN(text: string): string | null {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

/**
 * A financial year as people write it: the stored label `25-26` (or the start year) becomes `2025-26`.
 * The stored label is not changed (document numbers carry it); this is for showing.
 */
export function fyDisplayLabel(label: string | number): string {
  if (typeof label === 'number') return `${pad(label, 4)}-${pad((label + 1) % 100)}`;
  const m = /^(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  const century = Number(m[1]) >= 70 ? 1900 : 2000;
  return `${century + Number(m[1])}-${m[2]}`;
}

function group(digits: string): string {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
}

export type RupeeStyle = 'sign' | 'rs' | 'plain';

/**
 * Integer paise as rupees with lakh grouping. `sign` is ₹1,23,456.00 (the sign touches the number, and
 * a minus goes before the sign); `rs` is the plain-text form Rs. 1,23,456.00 with a space, for places
 * that cannot show ₹; `plain` has no symbol.
 */
export function formatRupees(paise: number | bigint, style: RupeeStyle = 'sign'): string {
  const n = BigInt(paise);
  const abs = n < 0n ? -n : n;
  const body = `${group((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  const text = style === 'sign' ? `₹${body}` : style === 'rs' ? `Rs. ${body}` : body;
  return n < 0n ? `-${text}` : text;
}
