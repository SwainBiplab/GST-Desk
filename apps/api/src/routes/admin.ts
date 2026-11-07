/**
 * Internal pages for the people who run the service: queue depths and the dead-letter queue, usage
 * totals. Open only to owners of the internal organisation named in INTERNAL_ORG_ID.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

import { subApp, type App, type Vars } from '../app';
import { orgsOf } from '../auth/mirror';
import { errorSchema, forbidden, notFound, unauthorized } from '../errors';

import type { RouteDeps } from './index';

const errors = {
  401: { description: 'Not signed in', content: { 'application/json': { schema: errorSchema } } },
  403: { description: 'Not an operator', content: { 'application/json': { schema: errorSchema } } },
};

export function requireOperator(deps: RouteDeps): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) throw unauthorized();
    const internal = deps.config.internalOrgId;
    if (!internal) throw forbidden('No internal organisation is configured on this server.');
    const m = (await orgsOf(deps.db, s.userId)).find((o) => o.id === internal);
    if (!m || m.role !== 'owner')
      throw forbidden('Only owners of the internal organisation may see this.');
    await next();
  };
}

const counts = z.record(
  z.string(),
  z.object({
    waiting: z.number(),
    active: z.number(),
    failed: z.number(),
    delayed: z.number(),
    dead: z.number(),
  }),
);

export function adminRoutes(app: App, deps: RouteDeps): void {
  const admin = subApp();
  admin.use('*', requireOperator(deps));

  admin.openapi(
    createRoute({
      method: 'get',
      path: '/queues',
      tags: ['admin'],
      summary: 'Jobs waiting, running, failed and dead, per queue',
      security: [{ bearer: [] }, { cookie: [] }],
      responses: {
        200: {
          description: 'Counts',
          content: {
            'application/json': {
              schema: z.object({
                queues: counts,
                dead: z.array(
                  z.object({
                    id: z.string(),
                    queue: z.string(),
                    name: z.string(),
                    failedReason: z.string(),
                    attemptsMade: z.number(),
                    orgId: z.string().nullable(),
                    diedAt: z.number(),
                  }),
                ),
              }),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!deps.jobs) return c.json({ queues: {}, dead: [] }, 200);
      const queues = await deps.jobs.counts();
      const deadJobs = await deps.jobs.dead.getJobs(
        ['waiting', 'delayed', 'completed', 'failed'],
        0,
        200,
      );
      return c.json(
        {
          queues,
          dead: deadJobs.map((j) => ({
            id: String(j.id),
            queue: j.data.queue,
            name: j.data.name,
            failedReason: j.data.failedReason,
            attemptsMade: j.data.attemptsMade,
            orgId: j.data.orgId,
            diedAt: j.data.diedAt,
          })),
        },
        200,
      );
    },
  );

  admin.openapi(
    createRoute({
      method: 'post',
      path: '/queues/dead/:id/retry',
      tags: ['admin'],
      summary: 'Put a dead job back on its queue',
      security: [{ bearer: [] }, { cookie: [] }],
      request: {
        params: z.object({
          id: z
            .string()
            .min(1)
            .max(64)
            .openapi({ param: { name: 'id', in: 'path' } }),
        }),
      },
      responses: {
        200: {
          description: 'Requeued',
          content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
        },
        ...errors,
        404: {
          description: 'No such dead job',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!deps.jobs || !(await deps.jobs.retryDead(id))) throw notFound('That job');
      return c.json({ ok: true as const }, 200);
    },
  );

  admin.openapi(
    createRoute({
      method: 'get',
      path: '/usage',
      tags: ['admin'],
      summary: 'Metered usage per organisation for a month, for the pricing decision',
      security: [{ bearer: [] }, { cookie: [] }],
      request: { query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }) },
      responses: {
        200: {
          description: 'Usage',
          content: {
            'application/json': {
              schema: z.array(
                z.object({ orgId: z.string(), kind: z.string(), quantity: z.number() }),
              ),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { month } = c.req.valid('query');
      const from = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
      const to = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
      // the operator reads across organisations: the internal organisation's own setting is not what RLS
      // wants here, so this one query goes through a row-level-security bypass view made for operators
      const rows = await deps.db
        .sql`SELECT org_id, kind, sum(quantity)::bigint AS quantity FROM usage_events_all WHERE at >= ${from} AND at < ${to} GROUP BY org_id, kind ORDER BY org_id, kind`;
      return c.json(
        rows.map((r) => ({
          orgId: String(r['org_id']),
          kind: String(r['kind']),
          quantity: Number(r['quantity']),
        })),
        200,
      );
    },
  );

  app.route('/v1/admin', admin as never);
}
