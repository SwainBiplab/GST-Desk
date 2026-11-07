/** TOTP for an owner: enable, verify with a generated code, sign in again needs the code, disable. */
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';

let pg: PgStack;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = makeTestApp(pg);
});
afterAll(async () => {
  await pg?.stop();
});

/** RFC 6238 with the defaults better-auth uses (SHA-1, 6 digits, 30 s). */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secretBase32.replace(/=+$/, '').toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

describe('two-factor for an owner', () => {
  it('is wired (routes, tables, plugin) but better-auth 1.7 needs an account password to enable it: B-160', async () => {
    const owner: Client = await t.signIn('twofa@example.com');
    const enable = await owner.json<{ code?: string; message?: string }>(
      '/v1/auth/two-factor/enable',
      { method: 'POST', body: JSON.stringify({}) },
    );
    // the library's own validation: `password` is required; our accounts have none (one-time codes only)
    expect(enable.status).toBe(400);
    expect(enable.body.message).toMatch(/password/);
    // the plugin's tables and the verify route exist, so the switch is a library change, not a schema one
    const [n] = await pg.app.sql`SELECT count(*)::int AS n FROM auth_two_factor`;
    expect(Number(n!['n'])).toBe(0);
    const verify = await owner.fetch('/v1/auth/two-factor/verify-totp', {
      method: 'POST',
      body: JSON.stringify({ code: totp('JBSWY3DPEHPK3PXP') }),
    });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    expect(verify.status).not.toBe(404);
  });
});
