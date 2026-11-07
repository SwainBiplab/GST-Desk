/** Device tokens. Only a hash is ever stored; the token itself is shown to the device once. */

export const TOKEN_ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** The old token keeps working this long after a rotation, in case the reply carrying the new one was lost. */
export const TOKEN_GRACE_MS = 10 * 60 * 1000;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** 256 bits from the platform's random source. */
export function newToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two strings without stopping at the first difference. */
export function sameSecret(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
