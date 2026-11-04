/** GSTIN and PAN validation (format + mod-36 checksum). */
import { STATES } from './tax/supply';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;
export const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14.charAt(i));
    if (v < 0) throw new RangeError(`invalid GSTIN character at ${i}`);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS.charAt((36 - (sum % 36)) % 36);
}

export type GstinCheck =
  | { valid: true; stateCode: string; pan: string }
  | { valid: false; reason: 'format' | 'state' | 'checksum' };

export function checkGstin(input: string): GstinCheck {
  const g = input.trim().toUpperCase();
  const m = GSTIN.exec(g);
  if (!m) return { valid: false, reason: 'format' };
  if (!Object.hasOwn(STATES, m[1]!)) return { valid: false, reason: 'state' };
  if (gstinCheckChar(g.slice(0, 14)) !== g.charAt(14)) return { valid: false, reason: 'checksum' };
  return { valid: true, stateCode: m[1]!, pan: m[2]! };
}
