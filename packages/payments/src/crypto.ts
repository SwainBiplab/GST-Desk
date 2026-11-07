import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Constant-time equality of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex');

const key = (b64: string): Buffer => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32)
    throw new Error('SECRETS_KEY must be 32 bytes, base64 (openssl rand -base64 32)');
  return k;
};

/**
 * A gateway secret as stored: AES-256-GCM under the platform's key, `v1.<iv>.<tag>.<ciphertext>` in base64url.
 * The key lives in the environment, never in the database, so a database dump alone opens nothing. `aad`
 * (the organisation) binds a sealed value to its owner: a value copied to another organisation does not open.
 */
export function sealSecret(plain: string, keyB64: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(keyB64), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function openSecret(sealed: string, keyB64: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('not a sealed secret');
  const d = createDecipheriv('aes-256-gcm', key(keyB64), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
