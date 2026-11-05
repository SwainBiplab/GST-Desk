/**
 * Credentials are kept only in encrypted form, under a key made from a PIN the person chooses: PBKDF2
 * (SHA-256, 310,000 rounds) to an AES-256-GCM key, with a fresh salt and nonce each time. The PIN itself
 * is never stored. Works in the browser and in Node (WebCrypto in both).
 */
import type { GspCredentials } from './types';

const ROUNDS = 310_000;

export interface SealedCredentials {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

export class WrongPinError extends Error {
  override name = 'WrongPinError';
  constructor() {
    super('That PIN does not open the saved credentials.');
  }
}

const b64 = (u: Uint8Array): string => {
  let s = '';
  for (const byte of u) s += String.fromCharCode(byte);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A PIN must be at least 6 characters; digits only is allowed. */
export const pinProblem = (pin: string): string | null =>
  pin.length < 6 ? 'The PIN must be at least 6 characters.' : null;

async function keyFrom(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  rounds: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealCredentials(
  creds: GspCredentials,
  pin: string,
  opts: { rounds?: number } = {},
): Promise<SealedCredentials> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const key = await keyFrom(pin, salt, opts.rounds ?? ROUNDS);
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(creds)),
    ),
  );
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function openCredentials(
  sealed: SealedCredentials,
  pin: string,
  opts: { rounds?: number } = {},
): Promise<GspCredentials> {
  const key = await keyFrom(pin, unb64(sealed.salt), opts.rounds ?? ROUNDS);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv) },
      key,
      unb64(sealed.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as GspCredentials;
  } catch {
    throw new WrongPinError();
  }
}
