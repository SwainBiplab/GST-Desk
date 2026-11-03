const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GSTIN check character (mod-36 weighted sum over the first 14 characters). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14.charAt(i));
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS.charAt((36 - (sum % 36)) % 36);
}

export type GstinState = 'empty' | 'incomplete' | 'bad-format' | 'bad-checksum' | 'valid';

export function gstinState(input: string): GstinState {
  const v = input.toUpperCase();
  if (v.length === 0) return 'empty';
  if (v.length < 15) return /^[0-9A-Z]*$/.test(v) ? 'incomplete' : 'bad-format';
  if (!FORMAT.test(v)) return 'bad-format';
  return gstinCheckChar(v.slice(0, 14)) === v.charAt(14) ? 'valid' : 'bad-checksum';
}
