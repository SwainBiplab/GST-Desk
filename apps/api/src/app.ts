/**
 * The Hono application: request ids, a logger per request, body and rate limits, health and readiness,
 * the OpenAPI document, and the error envelope. Routes are mounted under `/v1`; `routes/*` add them.
 */
import { OpenAPIHono, createRoute, z, type Hook } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';

import type { Auth } from './auth/auth';
import type { Config } from './config';
import type { PgDatabase } from './db/pool';
import { ApiError, errorSchema, onError } from './errors';
import type { Limiter } from './limits';
import type { Telemetry } from './telemetry';

export interface Deps {
  config: Config;
  log: Logger;
  /** The app role's connection (row-level security applies). */
  db: PgDatabase;
  auth: Auth;
  ipLimiter: Limiter;
  orgLimiter: Limiter;
  /** Dependencies checked by `/readyz`. */
  ready: () => Promise<Record<string, boolean>>;
  telemetry?: Telemetry;
}

export interface Vars {
  requestId: string;
  log: Logger;
  deps: Deps;
  /** Set by the session middleware. */
  session: { userId: string; sessionId: string; activeOrganizationId: string | null } | null;
}

export type App = OpenAPIHono<{ Variables: Vars }>;

export const requestId: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

/** The caller's address: the socket's, or the proxy's header when the deployment says there is a proxy. */
export const clientIp = (c: Context, trustProxy: boolean): string => {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return socket || 'unknown';
};

const ipLimit: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const deps = c.get('deps');
  const r = await deps.ipLimiter.take(`ip:${clientIp(c, deps.config.trustProxy)}`);
  c.header('x-ratelimit-remaining', String(r.remaining));
  if (!r.ok) {
    c.header('retry-after', String(Math.ceil(r.resetMs / 1000)));
    throw new ApiError(
      429,
      'rate_limited',
      'Too many requests from this address. Try again shortly.',
    );
  }
  await next();
};

/** What a failed body or query validation answers with: the same envelope as every other error. */
export const validationHook: Hook<unknown, { Variables: Vars }, string, unknown> = (result, c) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: 'validation',
          message: 'The request did not match what was expected.',
          details: result.error.issues,
          requestId: c.get('requestId'),
        },
      },
      400,
    );
  }
  return undefined;
};

/** A route group that joins the main app's OpenAPI document when mounted with `app.route`. */
export const subApp = (): App =>
  new OpenAPIHono<{ Variables: Vars }>({ defaultHook: validationHook });

export function createApp(deps: Deps): App {
  const app = new OpenAPIHono<{ Variables: Vars }>({ defaultHook: validationHook });

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', requestId);
  app.use('*', async (c, next) => {
    const log = deps.log.child({ requestId: c.get('requestId') });
    c.set('log', log);
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request');
    deps.telemetry?.requestDuration.record(ms, {
      'http.request.method': c.req.method,
      'http.route': c.req.routePath,
      'http.response.status_code': c.res.status,
    });
  });
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: deps.config.limits.maxBodyBytes,
      onError: (c) =>
        c.json(
          {
            error: {
              code: 'too_large',
              message: 'The request body is too large.',
              requestId: c.get('requestId'),
            },
          },
          413,
        ),
    }),
  );
  app.use('/v1/*', ipLimit);
  app.onError(onError);
  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', message: 'No such route.', requestId: c.get('requestId') } },
      404,
    ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/healthz',
      tags: ['system'],
      summary: 'Liveness',
      responses: {
        200: {
          description: 'The process is up',
          content: {
            'application/json': { schema: z.object({ ok: z.literal(true), version: z.string() }) },
          },
        },
      },
    }),
    (c) => c.json({ ok: true as const, version: VERSION }, 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/readyz',
      tags: ['system'],
      summary: 'Readiness: the database and the other services answer',
      responses: {
        200: {
          description: 'Ready',
          content: {
            'application/json': {
              schema: z.object({ ok: z.literal(true), checks: z.record(z.string(), z.boolean()) }),
            },
          },
        },
        503: {
          description: 'Not ready',
          content: {
            'application/json': {
              schema: z.object({ ok: z.literal(false), checks: z.record(z.string(), z.boolean()) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const checks = await deps.ready();
      const ok = Object.values(checks).every(Boolean);
      return ok
        ? c.json({ ok: true as const, checks }, 200)
        : c.json({ ok: false as const, checks }, 503);
    },
  );

  app.doc('/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'GST Desk API',
      version: VERSION,
      description:
        'The cloud tier: organisations, businesses, members, files and jobs. Every route is under /v1.',
    },
    servers: [{ url: deps.config.baseUrl }],
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'cookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'gstdesk.session_token',
  });
  app.openAPIRegistry.register('Error', errorSchema);
  return app;
}

export const VERSION = '0.1.0';
