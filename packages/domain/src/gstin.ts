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

/** Fourth letter of a PAN: the kind of taxpayer. */
export const ENTITY_TYPES: Record<string, string> = {
  P: 'Individual',
  C: 'Company',
  H: 'Hindu undivided family',
  F: 'Firm or LLP',
  A: 'Association of persons',
  B: 'Body of individuals',
  T: 'Trust',
  L: 'Local authority',
  J: 'Artificial juridical person',
  G: 'Government',
};

/** Taxpayer kind from a PAN (its 4th character), or null if the letter is unknown. */
export function entityType(pan: string): { letter: string; label: string } | null {
  const letter = pan.trim().toUpperCase().charAt(3);
  const label = ENTITY_TYPES[letter];
  return label ? { letter, label } : null;
}

export interface GstinDetails {
  gstin: string;
  stateCode: string;
  stateName: string;
  pan: string;
  entity: { letter: string; label: string } | null;
  /** The 13th character: how many registrations this PAN holds in the state. */
  registrationNumber: string;
}

/** Everything that can be read off a valid GSTIN, or the reason it is not valid. */
export function parseGstin(
  input: string,
): { ok: true; details: GstinDetails } | { ok: false; reason: 'format' | 'state' | 'checksum' } {
  const c = checkGstin(input);
  if (!c.valid) return { ok: false, reason: c.reason };
  const gstin = input.trim().toUpperCase();
  return {
    ok: true,
    details: {
      gstin,
      stateCode: c.stateCode,
      stateName: STATES[c.stateCode]!,
      pan: c.pan,
      entity: entityType(c.pan),
      registrationNumber: gstin.charAt(12),
    },
  };
}
