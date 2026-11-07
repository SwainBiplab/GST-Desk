/**
 * Organisations and their businesses. Creating an organisation goes through better-auth (so the caller
 * becomes its owner and the mirror makes the shared rows); everything under `/v1/orgs/:orgId` runs as a
 * member with the organisation set on the transaction. Businesses use `BusinessRepo`, which audits.
 */
import { BusinessRepo, type Row } from '@gst/db';
import { STATES } from '@gst/domain';
import { createRoute, z } from '@hono/zod-openapi';

import { subApp, type App } from '../app';
import { orgsOf } from '../auth/mirror';
import { ORG_ROLES } from '../auth/options';
import { ApiError, errorSchema, notFound, unauthorized } from '../errors';
import { requireOrg, requirePermission, requireSession, type OrgVars } from '../middleware/session';

import { orgSummary } from './me';

import type { RouteDeps } from './index';

const stateCodes = Object.keys(STATES);

const businessSchema = z
  .object({
    id: z.string().uuid(),
    legalName: z.string(),
    tradeName: z.string().nullable(),
    gstin: z.string().nullable(),
    stateCode: z.string(),
    scheme: z.enum(['regular', 'composition']),
    fyStartMonth: z.number().int(),
    version: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('Business');

const businessInput = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    tradeName: z.string().trim().max(200).optional(),
    gstin: z
      .string()
      .trim()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
      .optional(),
    stateCode: z.string().refine((s) => stateCodes.includes(s), 'unknown state code'),
    scheme: z.enum(['regular', 'composition']).default('regular'),
    fyStartMonth: z.number().int().min(1).max(12).default(4),
  })
  .openapi('BusinessInput');

const memberSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    role: z.enum(ORG_ROLES),
    createdAt: z.number(),
  })
  .openapi('Member');

const toBusiness = (r: Row) => ({
  id: String(r['id']),
  legalName: String(r['legal_name']),
  tradeName: r['trade_name'] ? String(r['trade_name']) : null,
  gstin: r['gstin'] ? String(r['gstin']) : null,
  stateCode: String(r['state_code']),
  scheme: (r['scheme'] === 'composition' ? 'composition' : 'regular') as 'regular' | 'composition',
  fyStartMonth: Number(r['fy_start_month'] ?? 4),
  version: Number(r['version']),
  createdAt: Number(r['created_at']),
  updatedAt: Number(r['updated_at']),
});

const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const businessParam = orgParam.extend({
  businessId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'businessId', in: 'path' } }),
});
const security = [{ bearer: [] }, { cookie: [] }];
const errors = {
  401: { description: 'Not signed in', content: { 'application/json': { schema: errorSchema } } },
  403: {
    description: 'Not allowed for this role',
    content: { 'application/json': { schema: errorSchema } },
  },
  404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
};

export function orgRoutes(app: App, deps: RouteDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/orgs',
      tags: ['organisations'],
      summary: 'The organisations the caller belongs to',
      security,
      middleware: [requireSession] as const,
      responses: {
        200: {
          description: 'Organisations',
          content: { 'application/json': { schema: z.array(orgSummary) } },
        },
        401: errors[401],
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      return c.json(await orgsOf(deps.db, s.userId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/orgs',
      tags: ['organisations'],
      summary: 'Create an organisation; the caller becomes its owner',
      security,
      middleware: [requireSession] as const,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ name: z.string().trim().min(1).max(120) }).openapi('OrgInput'),
            },
          },
        },
      },
      responses: {
        201: { description: 'Created', content: { 'application/json': { schema: orgSummary } } },
        401: errors[401],
        422: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const { name } = c.req.valid('json');
      const slug = `${
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'org'
      }-${crypto.randomUUID().slice(0, 8)}`;
      let created: { id: string; name: string } | null;
      try {
        created = (await deps.auth.api.createOrganization({
          headers: c.req.raw.headers,
          body: { name, slug },
        })) as { id: string; name: string } | null;
      } catch (e) {
        throw new ApiError(
          422,
          'org_refused',
          e instanceof Error ? e.message : 'The organisation could not be created.',
        );
      }
      if (!created)
        throw new ApiError(422, 'org_refused', 'The organisation could not be created.');
      return c.json({ id: created.id, name: created.name, role: 'owner' as const }, 201);
    },
  );

  const org = subApp();
  org.use('*', requireOrg as never);

  org.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['organisations'],
      summary: 'One organisation, with its members',
      security,
      request: { params: orgParam },
      responses: {
        200: {
          description: 'Organisation',
          content: {
            'application/json': {
              schema: orgSummary.extend({ members: z.array(memberSchema), plan: z.string() }),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const o = c.get('org' as never) as OrgVars['org'];
      const rows = await deps.db
        .sql`SELECT m.id, m.user_id, m.role, m.created_at, u.name, u.email FROM auth_member m JOIN auth_user u ON u.id = m.user_id WHERE m.organization_id = ${o.id} ORDER BY m.created_at`;
      const [orgRow] = await deps.db.sql`SELECT plan FROM organisations WHERE id = ${o.id}`;
      return c.json(
        {
          ...o,
          plan: String(orgRow?.['plan'] ?? 'free'),
          members: rows.map((r) => ({
            id: String(r['id']),
            userId: String(r['user_id']),
            name: String(r['name']),
            email: r['email'] ? String(r['email']) : null,
            role: String(r['role']) as (typeof ORG_ROLES)[number],
            createdAt: new Date(r['created_at'] as string).getTime(),
          })),
        },
        200,
      );
    },
  );

  org.openapi(
    createRoute({
      method: 'get',
      path: '/businesses',
      tags: ['businesses'],
      summary: 'The businesses of an organisation',
      security,
      request: { params: orgParam },
      responses: {
        200: {
          description: 'Businesses',
          content: { 'application/json': { schema: z.array(businessSchema) } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const ctx = c.get('ctx' as never) as OrgVars['ctx'];
      const rows = await new BusinessRepo(deps.db).list(ctx);
      return c.json(rows.map(toBusiness), 200);
    },
  );

  org.openapi(
    createRoute({
      method: 'post',
      path: '/businesses',
      tags: ['businesses'],
      summary: 'Create a business in the organisation',
      security,
      middleware: [requirePermission('business', 'create')] as const,
      request: {
        params: orgParam,
        body: { content: { 'application/json': { schema: businessInput } } },
      },
      responses: {
        201: {
          description: 'Created',
          content: { 'application/json': { schema: businessSchema } },
        },
        ...errors,
        422: {
          description: 'Refused by a rule',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const ctx = c.get('ctx' as never) as OrgVars['ctx'];
      const b = c.req.valid('json');
      const row = await new BusinessRepo(deps.db).create(ctx, {
        legal_name: b.legalName,
        trade_name: b.tradeName ?? null,
        gstin: b.gstin ?? null,
        state_code: b.stateCode,
        scheme: b.scheme,
        fy_start_month: b.fyStartMonth,
      });
      return c.json(toBusiness(row), 201);
    },
  );

  org.openapi(
    createRoute({
      method: 'get',
      path: '/businesses/:businessId',
      tags: ['businesses'],
      summary: 'One business',
      security,
      request: { params: businessParam },
      responses: {
        200: {
          description: 'Business',
          content: { 'application/json': { schema: businessSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const ctx = c.get('ctx' as never) as OrgVars['ctx'];
      const { businessId } = c.req.valid('param');
      const row = await new BusinessRepo(deps.db).get({ ...ctx, businessId }, businessId);
      if (!row) throw notFound('That business');
      return c.json(toBusiness(row), 200);
    },
  );

  org.openapi(
    createRoute({
      method: 'patch',
      path: '/businesses/:businessId',
      tags: ['businesses'],
      summary: 'Change a business (optimistic: send the version you saw)',
      security,
      middleware: [requirePermission('business', 'update')] as const,
      request: {
        params: businessParam,
        body: {
          content: {
            'application/json': {
              schema: businessInput.partial().extend({ version: z.number().int() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Updated',
          content: { 'application/json': { schema: businessSchema } },
        },
        ...errors,
        409: {
          description: 'Someone else changed it first',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const ctx = c.get('ctx' as never) as OrgVars['ctx'];
      const { businessId } = c.req.valid('param');
      const { version, ...patch } = c.req.valid('json');
      const repo = new BusinessRepo(deps.db);
      const scoped = { ...ctx, businessId };
      if (!(await repo.get(scoped, businessId))) throw notFound('That business');
      const row = await repo.update(
        scoped,
        {
          ...(patch.legalName !== undefined ? { legal_name: patch.legalName } : {}),
          ...(patch.tradeName !== undefined ? { trade_name: patch.tradeName } : {}),
          ...(patch.gstin !== undefined ? { gstin: patch.gstin } : {}),
          ...(patch.stateCode !== undefined ? { state_code: patch.stateCode } : {}),
          ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
          ...(patch.fyStartMonth !== undefined ? { fy_start_month: patch.fyStartMonth } : {}),
        },
        version,
      );
      return c.json(toBusiness(row), 200);
    },
  );

  app.route('/v1/orgs/:orgId', org as never);
}
