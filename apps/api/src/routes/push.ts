/** Push tokens (prompt 43): a phone registers, and forgets itself on sign-out. */
import { createRoute, z } from '@hono/zod-openapi';

import type { App } from '../app';
import { errorSchema, unauthorized } from '../errors';
import { requireSession } from '../middleware/session';

import type { RouteDeps } from './index';

const errors = {
  401: { description: 'Not signed in', content: { 'application/json': { schema: errorSchema } } },
};

export function pushRoutes(app: App, deps: RouteDeps): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/me/push-tokens',
      tags: ['push'],
      summary: 'Register this device for push notifications',
      security: [{ bearer: [] }, { cookie: [] }],
      middleware: [requireSession] as const,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  token: z.string().min(20).max(4096),
                  deviceId: z.string().max(64).optional(),
                  platform: z.enum(['android', 'ios']),
                })
                .openapi('PushTokenInput'),
            },
          },
        },
      },
      responses: { 204: { description: 'Registered' }, ...errors },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const b = c.req.valid('json');
      const now = Date.now();
      await deps.db
        .sql`INSERT INTO push_tokens (token, user_id, device_id, platform, created_at, updated_at)
        VALUES (${b.token}, ${s.userId}, ${b.deviceId ?? null}, ${b.platform}, ${now}, ${now})
        ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id, updated_at = ${now}`;
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/me/push-tokens/{token}',
      tags: ['push'],
      summary: 'Forget a push token (sign-out)',
      security: [{ bearer: [] }, { cookie: [] }],
      middleware: [requireSession] as const,
      request: {
        params: z.object({
          token: z
            .string()
            .min(1)
            .openapi({ param: { name: 'token', in: 'path' } }),
        }),
      },
      responses: { 204: { description: 'Forgotten' }, ...errors },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const { token } = c.req.valid('param');
      await deps.db.sql`DELETE FROM push_tokens WHERE token = ${token} AND user_id = ${s.userId}`;
      return c.body(null, 204);
    },
  );
}
