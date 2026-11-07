/**
 * Pairing: the desktop shows a one-time code (and a QR holding it); a tablet that enters it within five
 * minutes becomes a paired device. A code works once. Wrong guesses burn it, so the six or eight digits
 * cannot be walked through, and a source that keeps guessing is shut out for a while.
 */
import type { Role } from './roles';
import { sameSecret } from './tokens';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const MAX_WRONG_GUESSES = 5;
export const LOCKOUT_MS = 60 * 1000;

export interface PairingOffer {
  code: string;
  expiresAt: number;
  /** What the device that uses it may do. */
  role: Role;
}

export type RedeemResult =
  { ok: true; role: Role } | { ok: false; code: 'no_offer' | 'expired' | 'wrong_code' | 'locked' };

function digits(n: number): string {
  const out: number[] = [];
  const buf = crypto.getRandomValues(new Uint32Array(n));
  for (const v of buf) out.push(v % 10);
  return out.join('');
}

export class Pairer {
  private offer: (PairingOffer & { wrong: number }) | null = null;
  private readonly lockedUntil = new Map<string, number>();

  /** Make a fresh code, replacing any open one. */
  start(now: number, role: Role = 'counter'): PairingOffer {
    this.offer = { code: digits(8), expiresAt: now + PAIRING_TTL_MS, role, wrong: 0 };
    return { code: this.offer.code, expiresAt: this.offer.expiresAt, role };
  }

  cancel(): void {
    this.offer = null;
  }

  open(now: number): PairingOffer | null {
    return this.offer && this.offer.expiresAt > now
      ? { code: this.offer.code, expiresAt: this.offer.expiresAt, role: this.offer.role }
      : null;
  }

  /** Try a code from a source (an address). A good code is used up. */
  redeem(code: string, source: string, now: number): RedeemResult {
    if ((this.lockedUntil.get(source) ?? 0) > now) return { ok: false, code: 'locked' };
    const o = this.offer;
    if (!o) return { ok: false, code: 'no_offer' };
    if (o.expiresAt <= now) {
      this.offer = null;
      return { ok: false, code: 'expired' };
    }
    if (!sameSecret(code.trim(), o.code)) {
      o.wrong += 1;
      if (o.wrong >= MAX_WRONG_GUESSES) {
        this.offer = null;
        this.lockedUntil.set(source, now + LOCKOUT_MS);
      }
      return { ok: false, code: 'wrong_code' };
    }
    this.offer = null;
    return { ok: true, role: o.role };
  }
}

/** What the QR holds: where to go, the code, and the certificate's fingerprint to pin. */
export function pairingUri(p: {
  host: string;
  port: number;
  code: string;
  fingerprint: string;
}): string {
  const q = new URLSearchParams({ code: p.code, fp: p.fingerprint });
  return `https://${p.host}:${p.port}/pair?${q.toString()}`;
}
