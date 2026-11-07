/**
 * Push (prompt 43): a phone's token is kept per user and forgotten on sign-out; the FCM exchange signs
 * a service-account JWT and sends data-only messages, with tokens FCM reports gone dropped.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FcmSender, fcmMessage, serviceJwt } from '../src/push/fcm';
import { tokensOfOrg } from '../src/push/notify';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';

let pg: PgStack;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = makeTestApp(pg);
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  project_id: 'gst-test',
  client_email: 'fcm@gst-test.iam.gserviceaccount.com',
  private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};

describe('the FCM exchange', () => {
  it('signs a JWT the public key verifies, with the messaging scope and an hour to live', () => {
    const jwt = serviceJwt(sa, 1_700_000_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      exp: 1_700_003_600,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(keys.publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });

  it('sends data-only messages and reports tokens that are gone', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.includes('oauth2'))
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
      return new Response(url ? '{}' : '', {
        status: String(init?.body).includes('dead-token') ? 404 : 200,
      });
    }) as typeof fetch;
    const sender = new FcmSender(sa, fetchFn);
    const r = await sender.send(['live-token', 'dead-token'], { kind: 'inbox', count: 2 });
    expect(r).toEqual({ sent: 1, gone: ['dead-token'] });
    // one token exchange, then a message per device
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('messages:send'))).toHaveLength(2);
    expect(fcmMessage('x', { kind: 'reminder' })).toEqual({
      message: {
        token: 'x',
        data: { kind: 'reminder' },
        android: { priority: 'high', ttl: '3600s' },
      },
    });
  });
});

describe('push tokens', () => {
  let owner: Client;
  let orgId: string;

  it('a phone registers its token, and the organisation’s owners can be found by it', async () => {
    owner = await t.signIn('push-owner@example.com', 'Owner');
    orgId = (
      await owner.json<{ id: string }>('/v1/orgs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Push Traders' }),
      })
    ).body.id;
    const r = await owner.fetch('/v1/me/push-tokens', {
      method: 'POST',
      body: JSON.stringify({
        token: 'fcm-token-'.padEnd(40, 'a'),
        platform: 'android',
        deviceId: 'd1',
      }),
    });
    expect(r.status).toBe(204);
    expect(await tokensOfOrg(pg.app, orgId, { roles: ['owner', 'admin'] })).toEqual([
      'fcm-token-'.padEnd(40, 'a'),
    ]);
    expect(await tokensOfOrg(pg.app, orgId, { roles: ['viewer'] })).toEqual([]);
  });

  it('forgets a token on sign-out, and only its own', async () => {
    const other = await t.signIn('push-other@example.com');
    const token = 'fcm-token-'.padEnd(40, 'a');
    expect((await other.fetch(`/v1/me/push-tokens/${token}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(await tokensOfOrg(pg.app, orgId)).toEqual([token]);
    expect((await owner.fetch(`/v1/me/push-tokens/${token}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(await tokensOfOrg(pg.app, orgId)).toEqual([]);
  });

  it('answers CORS for a configured origin only, exposing the sign-in token header', async () => {
    const pre = await t.app.request('/v1/me', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:1420',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    expect(pre.headers.get('access-control-allow-credentials')).toBe('true');
    const got = await owner.fetch('/v1/me', { headers: { origin: 'http://localhost:1420' } });
    expect(got.headers.get('access-control-expose-headers')).toContain('set-auth-token');
    const foreign = await owner.fetch('/v1/me', { headers: { origin: 'https://evil.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});
