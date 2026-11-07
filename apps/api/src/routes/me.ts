/** Who am I: the signed-in user and the organisations they belong to. */
import { createRoute, z } from '@hono/zod-openapi';

import type { App } from '../app';
import { orgsOf } from '../auth/mirror';
import { ORG_ROLES } from '../auth/options';
import { errorSchema, unauthorized } from '../errors';
import { requireSession } from '../middleware/session';

import type { RouteDeps } from './index';

export const orgSummary = z
  .object({ id: z.string().uuid(), name: z.string(), role: z.enum(ORG_ROLES) })
  .openapi('OrgSummary');

export const meSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      name: z.string(),
      locale: z.string(),
    }),
    organisations: z.array(orgSummary),
    activeOrganizationId: z.string().nullable(),
  })
  .openapi('Me');

export function meRoutes(app: App, deps: RouteDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me',
      tags: ['me'],
      summary: 'The signed-in user and their organisations',
      security: [{ bearer: [] }, { cookie: [] }],
      middleware: [requireSession] as const,
      responses: {
        200: { description: 'Me', content: { 'application/json': { schema: meSchema } } },
        401: {
          description: 'Not signed in',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const [row] = await deps.db
        .sql`SELECT id, email, phone, name, locale FROM users WHERE id = ${s.userId}`;
      if (!row) throw unauthorized('Your account is incomplete. Sign in again.');
      return c.json(
        {
          user: {
            id: String(row['id']),
            email: row['email'] ? String(row['email']) : null,
            phone: row['phone'] ? String(row['phone']) : null,
            name: String(row['name']),
            locale: String(row['locale'] ?? 'en'),
          },
          organisations: await orgsOf(deps.db, s.userId),
          activeOrganizationId: s.activeOrganizationId,
        },
        200,
      );
    },
  );
}
