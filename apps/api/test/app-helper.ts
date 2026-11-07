/** The whole app over a real Postgres (and optionally Redis and MinIO), with the mock code sender. */
import pino from 'pino';

import { createApp, type App } from '../src/app';
import { makeAuth, type Auth } from '../src/auth/auth';
import { mirrorInto } from '../src/auth/mirror';
import { mockOtpSender, type MockOtpSender } from '../src/auth/otp';
import { loadConfig, type Config } from '../src/config';
import type { Jobs } from '../src/jobs/queues';
import { MemoryLimiter } from '../src/limits';
import { mountRoutes } from '../src/routes';
import type { RouteDeps } from '../src/routes';
import type { Storage } from '../src/storage/s3';

import type { PgStack } from './containers';

export interface TestApp {
  app: App;
  auth: Auth;
  otp: MockOtpSender;
  config: Config;
  /** Sign a user in by email code; returns the bearer token and the session cookie. */
  signIn(email: string, name?: string): Promise<Client>;
}

export interface Client {
  email: string;
  token: string;
  cookie: string;
  /** A request with the bearer token. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
}

export function makeTestApp(
  pg: PgStack,
  extra: {
    storage?: Storage | null;
    jobs?: Jobs | null;
    env?: Record<string, string>;
    messaging?: RouteDeps['messaging'];
    payments?: RouteDeps['payments'];
    filing?: RouteDeps['filing'];
    portals?: RouteDeps['portals'];
  } = {},
): TestApp {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: pg.adminUrl,
    APP_DATABASE_URL: pg.appUrl,
    INTERNAL_ORG_ID: extra.env?.['INTERNAL_ORG_ID'] ?? '',
    ...extra.env,
  });
  const otp = mockOtpSender();
  const auth = makeAuth({
    db: pg.app.db,
    secret: config.authSecret,
    baseUrl: config.baseUrl,
    otp,
    trustedOrigins: config.trustedOrigins,
    mirror: mirrorInto(pg.app),
    rateLimit: false,
  });
  const app = createApp({
    config,
    log: pino({ level: process.env['API_TEST_LOG'] ?? 'silent' }),
    db: pg.app,
    auth,
    ipLimiter: new MemoryLimiter(10_000),
    orgLimiter: new MemoryLimiter(10_000),
    ready: async () => ({ database: true }),
  });
  mountRoutes(app, {
    db: pg.app,
    auth,
    storage: extra.storage ?? null,
    jobs: extra.jobs ?? null,
    otp,
    config,
    ...(extra.messaging ? { messaging: extra.messaging } : {}),
    ...(extra.payments ? { payments: extra.payments } : {}),
    ...(extra.filing ? { filing: extra.filing } : {}),
    ...(extra.portals ? { portals: extra.portals } : {}),
  });

  const client = (email: string, token: string, cookie: string): Client => {
    const fetchFn = async (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin: 'http://localhost:1420',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    return {
      email,
      token,
      cookie,
      fetch: fetchFn,
      json: async (path, init) => {
        const r = await fetchFn(path, init);
        return { status: r.status, body: (await r.json()) as never };
      },
    };
  };

  return {
    app,
    auth,
    otp,
    config,
    async signIn(email, name = email.split('@')[0]!) {
      const headers = { 'content-type': 'application/json', origin: 'http://localhost:1420' };
      const sent = await app.request('/v1/auth/email-otp/send-verification-otp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, type: 'sign-in' }),
      });
      if (sent.status !== 200) throw new Error(`send otp: ${sent.status} ${await sent.text()}`);
      const code = otp.last(email);
      if (!code) throw new Error('no code was sent');
      const res = await app.request('/v1/auth/sign-in/email-otp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, otp: code, name }),
      });
      if (res.status !== 200) throw new Error(`sign in: ${res.status} ${await res.text()}`);
      const token = res.headers.get('set-auth-token') ?? '';
      const cookie = res.headers.get('set-cookie') ?? '';
      if (!token) throw new Error('no bearer token in the sign-in response');
      return client(email, token, cookie);
    },
  };
}
