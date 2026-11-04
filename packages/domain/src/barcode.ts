/** Barcode validation: GTIN check digits (EAN-8, UPC-A, EAN-13, GTIN-14) and free-form custom codes. */

export type BarcodeKind = 'ean8' | 'upca' | 'ean13' | 'gtin14' | 'custom';

export type BarcodeCheck =
  | { ok: true; kind: BarcodeKind; code: string }
  | { ok: false; reason: 'empty' | 'checksum' | 'chars' };

const GTIN_KIND: Record<number, BarcodeKind> = { 8: 'ean8', 12: 'upca', 13: 'ean13', 14: 'gtin14' };

/** The check digit for a GTIN body (every digit except the last). Weights 3,1 alternate from the right. */
export function gtinCheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new RangeError('a GTIN body is digits only');
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Append the check digit to a body of 7, 11, 12 or 13 digits. */
export const withCheckDigit = (body: string): string => `${body}${gtinCheckDigit(body)}`;

/**
 * Digit-only codes of 8, 12, 13 or 14 digits are GTINs and must have a correct check digit.
 * Any other digit string, or letters, digits and `. _ - /` up to 48 characters, is a custom code.
 */
export function validateBarcode(raw: string): BarcodeCheck {
  const code = raw.trim();
  if (code === '') return { ok: false, reason: 'empty' };
  if (/^\d+$/.test(code)) {
    const kind = GTIN_KIND[code.length];
    if (kind) {
      const expected = gtinCheckDigit(code.slice(0, -1));
      return expected === code.charCodeAt(code.length - 1) - 48
        ? { ok: true, kind, code }
        : { ok: false, reason: 'checksum' };
    }
    return code.length <= 48 ? { ok: true, kind: 'custom', code } : { ok: false, reason: 'chars' };
  }
  return /^[A-Za-z0-9._\-/]{1,48}$/.test(code)
    ? { ok: true, kind: 'custom', code }
    : { ok: false, reason: 'chars' };
}
