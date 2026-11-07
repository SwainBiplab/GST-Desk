import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time equality of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex');

/** Meta signs the raw body: `X-Hub-Signature-256: sha256=<hex>` with the app secret. */
export function verifyMetaSignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacHex(secret, rawBody));
}

/**
 * Resend signs webhooks with Svix: the signed content is `<id>.<timestamp>.<body>`, the key the base64 part of
 * the `whsec_` secret, the header a space-separated list of `v1,<base64>`. A timestamp more than five minutes
 * off is refused (replay).
 */
export function verifySvix(
  secret: string,
  h: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined },
  rawBody: string,
  now = Date.now(),
  toleranceMs = 5 * 60_000,
): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceMs) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${h.id}.${h.timestamp}.${rawBody}`)
    .digest('base64');
  return h.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && !!sig && safeEqual(sig, expected);
  });
}
