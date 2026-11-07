/**
 * The token a device shows the PowerSync service. HS256 with a secret only the API and the service
 * share; the organisation is in the token, so the sync rules can only ever stream that organisation's
 * businesses. The API checks membership before it signs.
 */
import { createHmac } from 'node:crypto';

/** Short, so a removed member's device stops downloading within minutes (uploads are checked per request). */
export const SYNC_TOKEN_SECONDS = 5 * 60;
export const SYNC_KID = 'gst-sync';

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export interface SyncClaims {
  sub: string;
  org_id: string;
  device_id: string;
  role: string;
}

export function signSyncToken(
  claims: SyncClaims,
  secret: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + SYNC_TOKEN_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: SYNC_KID }));
  const body = b64url(JSON.stringify({ ...claims, aud: 'powersync', iat, exp }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return { token: `${header}.${body}.${sig}`, expiresAt: exp * 1000 };
}

/** For tests: read a token back and check its signature. */
export function verifySyncToken(
  token: string,
  secret: string,
): (SyncClaims & { aud: string; exp: number }) | null {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) return null;
  const want = createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (want !== s) return null;
  return JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
}
