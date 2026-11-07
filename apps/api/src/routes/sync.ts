/**
 * Sync routes (prompt 41). A device asks for a PowerSync token, uploads its queued transactions, and
 * asks for number ranges. Downloads never come through here: the PowerSync service streams them.
 */
import { DocumentFlowRepo, NumberingRepo, newId, type Ctx } from '@gst/db';
import { createRoute, z } from '@hono/zod-openapi';

import type { App } from '../app';
import { orgsOf } from '../auth/mirror';
import { ApiError, errorSchema, forbidden, notFound, unauthorized } from '../errors';
import { requireSession } from '../middleware/session';
import { applyClientTx, clientTxSchema, type TxOutcome } from '../sync/apply';
import { signSyncToken } from '../sync/token';

import type { RouteDeps } from './index';

const security = [{ bearer: [] }, { cookie: [] }];
const errors = {
  401: { description: 'Not signed in', content: { 'application/json': { schema: errorSchema } } },
  403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
  404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
};

/** One upload at a time per organisation in this process, so number counters are taken in turn. */
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(orgId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(
    orgId,
    run.catch(() => undefined),
  );
  return run;
}

export function syncRoutes(app: App, deps: RouteDeps): void {
  const member = async (userId: string, orgId: string) => {
    const m = (await orgsOf(deps.db, userId)).find((o) => o.id === orgId);
    if (!m) throw notFound('That organisation');
    return m;
  };
  const device = async (orgId: string, userId: string, deviceId: string) => {
    const [row] = await deps.db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx`SELECT user_id, revoked_at FROM sync_devices WHERE id = ${deviceId}`;
    });
    if (!row) throw notFound('That device');
    if (row['revoked_at'] != null) throw forbidden('This device has been removed from sync.');
    if (row['user_id'] !== userId) throw forbidden('This device belongs to someone else.');
  };

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sync/token',
      tags: ['sync'],
      summary: 'Register this device for an organisation and get a token for the PowerSync service',
      security,
      middleware: [requireSession] as const,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  orgId: z.string().uuid(),
                  deviceId: z.string().uuid().optional(),
                  deviceName: z.string().trim().min(1).max(80),
                  platform: z.string().max(40).optional(),
                })
                .openapi('SyncTokenInput'),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Where to connect and with what',
          content: {
            'application/json': {
              schema: z
                .object({
                  endpoint: z.string(),
                  token: z.string(),
                  deviceId: z.string(),
                  expiresAt: z.number(),
                })
                .openapi('SyncToken'),
            },
          },
        },
        ...errors,
        503: {
          description: 'Sync is not configured',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      if (!deps.config.sync)
        throw new ApiError(503, 'no_sync', 'Sync is not configured on this server.');
      const b = c.req.valid('json');
      const m = await member(s.userId, b.orgId);
      const deviceId = b.deviceId ?? newId();
      const now = Date.now();
      await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${b.orgId}, true)`;
        const [row] = await tx`SELECT user_id, revoked_at FROM sync_devices WHERE id = ${deviceId}`;
        if (row && row['user_id'] !== s.userId)
          throw forbidden('This device belongs to someone else.');
        if (row && row['revoked_at'] != null)
          throw forbidden('This device has been removed from sync.');
        await tx`INSERT INTO sync_devices (id, org_id, user_id, name, platform, created_at, last_seen_at)
                 VALUES (${deviceId}, ${b.orgId}, ${s.userId}, ${b.deviceName}, ${b.platform ?? null}, ${now}, ${now})
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, last_seen_at = ${now}`;
      });
      const t = signSyncToken(
        { sub: s.userId, org_id: b.orgId, device_id: deviceId, role: m.role },
        deps.config.sync.jwtSecret,
      );
      return c.json(
        {
          endpoint: deps.config.sync.powersyncUrl,
          token: t.token,
          deviceId,
          expiresAt: t.expiresAt,
        },
        200,
      );
    },
  );

  const outcome = z.object({
    txId: z.number(),
    outcome: z.enum(['applied', 'duplicate', 'conflict', 'rejected']),
    reason: z.string().optional(),
    reviewItemId: z.string().optional(),
    renumbered: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })).optional(),
  });

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sync/write',
      tags: ['sync'],
      summary:
        'Upload queued local transactions; each is applied, merged, or turned into a conflict for a person',
      security,
      middleware: [requireSession] as const,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  orgId: z.string().uuid(),
                  deviceId: z.string().uuid(),
                  transactions: z.array(clientTxSchema).min(1).max(200),
                })
                .openapi('SyncWriteInput'),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'One outcome per transaction, in order',
          content: {
            'application/json': {
              schema: z.object({ results: z.array(outcome) }).openapi('SyncWriteResult'),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const b = c.req.valid('json');
      const m = await member(s.userId, b.orgId);
      await device(b.orgId, s.userId, b.deviceId);
      const caller = { orgId: b.orgId, userId: s.userId, deviceId: b.deviceId, role: m.role };
      const ctx: Ctx = { orgId: b.orgId, businessId: '', actor: s.userId, deviceId: b.deviceId };
      const results: TxOutcome[] = await inTurn(b.orgId, async () => {
        const out: TxOutcome[] = [];
        for (const t of b.transactions) out.push(await applyClientTx(deps.db, caller, ctx, t));
        return out;
      });
      return c.json({ results }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sync/ranges',
      tags: ['sync'],
      summary:
        'Reserve a block of numbers of a series for this device, to issue from while offline',
      security,
      middleware: [requireSession] as const,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  orgId: z.string().uuid(),
                  businessId: z.string().uuid(),
                  deviceId: z.string().uuid(),
                  /** The series to draw from; or the document type, whose default series is used (and made if needed). */
                  seriesKey: z.string().min(1).max(80).optional(),
                  documentType: z.string().min(1).max(40).optional(),
                  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  size: z.number().int().min(1).max(500).default(50),
                })
                .openapi('RangeInput'),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'The range',
          content: {
            'application/json': {
              schema: z
                .object({ id: z.string(), from: z.number(), to: z.number() })
                .openapi('Range'),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const b = c.req.valid('json');
      const m = await member(s.userId, b.orgId);
      if (m.role === 'viewer') throw forbidden('A viewer cannot issue documents.');
      await device(b.orgId, s.userId, b.deviceId);
      const ctx: Ctx = {
        orgId: b.orgId,
        businessId: b.businessId,
        actor: s.userId,
        deviceId: b.deviceId,
      };
      if (!b.seriesKey && !b.documentType)
        throw new ApiError(400, 'validation', 'Name a series or a document type.');
      const r = await inTurn(b.orgId, async () => {
        const key =
          b.seriesKey ??
          (await new DocumentFlowRepo(deps.db).ensureCounter(ctx, b.documentType!, b.date))
            .seriesKey;
        return new NumberingRepo(deps.db).reserveRange(ctx, key, b.size, b.date);
      });
      return c.json(r, 200);
    },
  );
}
