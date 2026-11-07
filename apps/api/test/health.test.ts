/** The app's plumbing without any service behind it: envelopes, ids, limits, configuration checks. */
import { ConflictError, RuleError } from '@gst/db';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createApp, type Deps } from '../src/app';
import { ConfigError, loadConfig } from '../src/config';
import { ApiError, toEnvelope } from '../src/errors';
import { MemoryLimiter } from '../src/limits';
import { scrub } from '../src/log';
import { mountRoutes } from '../src/routes';

const config = loadConfig({
  DATABASE_URL: 'postgres://x',
  NODE_ENV: 'test',
  RATE_LIMIT_IP_PER_MINUTE: '3',
  TRUST_PROXY: 'true',
});

function appWith(over: Partial<Deps> = {}) {
  const deps: Deps = {
    config,
    log: pino({ level: 'silent' }),
    db: { sql: Object.assign(async () => [], {}) } as never,
    auth: {
      handler: async () => new Response('auth', { status: 200 }),
      api: { getSession: async () => null },
    } as never,
    ipLimiter: new MemoryLimiter(config.limits.ipPerMinute),
    orgLimiter: new MemoryLimiter(config.limits.orgPerMinute),
    ready: async () => ({ database: true }),
    ...over,
  };
  const app = createApp(deps);
  mountRoutes(app, {
    db: deps.db,
    auth: deps.auth,
    storage: null,
    jobs: null,
    otp: { send: async () => undefined },
    config,
  });
  return app;
}

describe('health and readiness', () => {
  it('answers liveness, and readiness reflects the checks', async () => {
    const app = appWith();
    const live = await app.request('/healthz');
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    const down = appWith({ ready: async () => ({ database: false, redis: true }) });
    const r = await down.request('/readyz');
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, checks: { database: false, redis: true } });
  });

  it('serves the OpenAPI document with every route under /v1 and the error component', async () => {
    const res = await appWith().request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/v1/me');
    expect(paths).toContain('/v1/orgs');
    expect(paths).toContain('/v1/orgs/{orgId}/businesses');
    expect(paths).toContain('/v1/orgs/{orgId}/files/sign-upload');
    expect(paths).toContain('/v1/admin/queues');
    expect(
      paths.filter((p) => !p.startsWith('/v1/') && !['/healthz', '/readyz'].includes(p)),
    ).toEqual([]);
    expect(doc.components.schemas['Error']).toBeDefined();
  });
});

describe('request ids and the error envelope', () => {
  it('gives every response a request id, keeping a well-formed one from the client', async () => {
    const app = appWith();
    const fresh = await app.request('/healthz');
    expect(fresh.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await app.request('/healthz', { headers: { 'x-request-id': 'client-abc-123' } });
    expect(kept.headers.get('x-request-id')).toBe('client-abc-123');
    const odd = await app.request('/healthz', {
      headers: { 'x-request-id': 'no spaces allowed!' },
    });
    expect(odd.headers.get('x-request-id')).not.toBe('no spaces allowed!');
  });

  it('unknown routes, missing sessions and bad bodies come back as the envelope', async () => {
    const app = appWith();
    const missing = await app.request('/v1/nothing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: 'not_found', requestId: expect.any(String) },
    });
    const me = await app.request('/v1/me');
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const bad = await app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": 5}',
    });
    // validation runs after the session check here, so an anonymous bad body is still a 401
    expect(bad.status).toBe(401);
  });

  it('maps the repository errors and hides internals', () => {
    expect(toEnvelope(new RuleError('no'), 'r').status).toBe(422);
    expect(toEnvelope(new ConflictError('businesses', 'id', 3), 'r').status).toBe(409);
    expect(
      toEnvelope(new ApiError(418, 'teapot', 'short and stout'), 'r').body.error,
    ).toMatchObject({ code: 'teapot', requestId: 'r' });
    const internal = toEnvelope(new Error('connection string postgres://user:secret@host'), 'r');
    expect(internal.status).toBe(500);
    expect(JSON.stringify(internal.body)).not.toContain('secret');
  });
});

describe('limits', () => {
  it('refuses the fourth request in a minute from one address with a Retry-After', async () => {
    const app = appWith();
    const h = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 3; i++)
      expect((await app.request('/v1/me', { headers: h })).status).toBe(401);
    const fourth = await app.request('/v1/me', { headers: h });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
    // another address is not affected
    expect(
      (await app.request('/v1/me', { headers: { 'x-forwarded-for': '203.0.113.10' } })).status,
    ).toBe(401);
  });

  it('ignores a forged X-Forwarded-For when there is no proxy, so one client cannot spread its budget', async () => {
    const direct = appWith({
      config: loadConfig({
        DATABASE_URL: 'postgres://x',
        NODE_ENV: 'test',
        RATE_LIMIT_IP_PER_MINUTE: '3',
      }),
    });
    for (let i = 0; i < 3; i++)
      expect(
        (await direct.request('/v1/me', { headers: { 'x-forwarded-for': `203.0.113.${i}` } }))
          .status,
      ).toBe(401);
    expect(
      (await direct.request('/v1/me', { headers: { 'x-forwarded-for': '203.0.113.99' } })).status,
    ).toBe(429);
  });

  it('the token bucket refills at the per-minute rate', async () => {
    let now = 0;
    const l = new MemoryLimiter(60, () => now);
    for (let i = 0; i < 60; i++) expect((await l.take('k')).ok).toBe(true);
    expect((await l.take('k')).ok).toBe(false);
    now = 1_000; // one second later: one token back
    expect((await l.take('k')).ok).toBe(true);
    expect((await l.take('k')).ok).toBe(false);
  });

  it('refuses a body over the limit with 413', async () => {
    const app = appWith();
    const big = await app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) },
      body: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: 'too_large' } });
  });
});

describe('configuration', () => {
  it('runs with defaults in development and refuses them in production', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).authSecret.length).toBeGreaterThanOrEqual(
      32,
    );
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      APP_DATABASE_URL: 'postgres://y',
      BASE_URL: 'https://api.example.in',
      OTP_PROVIDER: 'msg91',
    };
    expect(() => loadConfig(prod)).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...prod, AUTH_SECRET: 'a'.repeat(40), BASE_URL: 'http://api.example.in' }),
    ).toThrow(/https/);
    expect(() =>
      loadConfig({ ...prod, AUTH_SECRET: 'a'.repeat(40), OTP_PROVIDER: 'mock' }),
    ).toThrow(/mock/);
    expect(() =>
      loadConfig({
        ...prod,
        AUTH_SECRET: 'a'.repeat(40),
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
      }),
    ).toThrow(/MinIO/);
    expect(loadConfig({ ...prod, AUTH_SECRET: 'a'.repeat(40) }).env).toBe('production');
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('scrubs personal data out of free text before it leaves', () => {
    expect(
      scrub('ramesh@example.com paid 9876543210 for 27AAPFU0939F1ZV pan AAPFU0939F id 123456789'),
    ).toBe('[email] paid [phone] for [gstin] pan [pan] id [number]');
  });
});
