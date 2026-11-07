/**
 * The customer's portal (prompt 47). Under an organisation: the portal settings of a business and its links
 * (made, listed, revoked). Public, under `/v1/p/{token}`: one invoice or one statement, its PDF, a payment link
 * for what is owed, and a question for the owner's inbox. The public routes carry no session, name nothing of
 * ours, answer "not found" to anything but a live token, and are rate limited by address and by token on top
 * of the API's own limit.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { clientIp, subApp, type App } from '../app';
import { ApiError, errorSchema, unauthorized } from '../errors';
import { MemoryLimiter, type Limiter } from '../limits';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';
import { PortalError, TOKEN_RE, type PortalService } from '../portals/links';

import type { RouteDeps } from './index';

const security = [{ bearer: [] }, { cookie: [] }];
const json = <T extends z.ZodTypeAny>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  401: json(errorSchema, 'Not signed in'),
  403: json(errorSchema, 'Not allowed for this role'),
  404: json(errorSchema, 'Not found'),
  422: json(errorSchema, 'Refused by a rule'),
};
const publicErrors = {
  404: json(errorSchema, 'No such link'),
  409: json(errorSchema, 'Nothing to pay'),
  410: json(errorSchema, 'The link has expired or was withdrawn'),
  429: json(errorSchema, 'Too many requests'),
  503: json(errorSchema, 'Not available'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const any = z.record(z.string(), z.unknown());
const businessQuery = z.object({ businessId: z.string().uuid() });
const tokenParam = z.object({
  token: z
    .string()
    .regex(TOKEN_RE)
    .openapi({ param: { name: 'token', in: 'path' } }),
});

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};

const STATUS: Record<PortalError['code'], number> = {
  not_found: 404,
  gone: 410,
  disabled: 410,
  no_payments: 503,
  nothing_owed: 409,
  rule: 422,
  limit: 429,
};
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortalError) throw new ApiError(STATUS[e.code], `portal_${e.code}`, e.message);
    throw e;
  }
}

export function portalRoutes(
  app: App,
  deps: RouteDeps,
  limiters: { ip: Limiter; token: Limiter } = {
    ip: new MemoryLimiter(deps.config.limits.portalPerMinute),
    token: new MemoryLimiter(deps.config.limits.portalPerMinute),
  },
): void {
  const svc = (): PortalService => {
    if (!deps.portals)
      throw new ApiError(503, 'no_portals', 'Customer pages are not available on this server.');
    return deps.portals.links;
  };

  /* ------------------------------------------------------------------------------ the owner */

  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/portal/settings',
      tags: ['portal'],
      summary: 'Whether customer pages are on for a business, and how long a link lives',
      security,
      middleware: [requirePermission('settings', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(any), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          svc().settings(orgOf(c as never).id, c.req.valid('query').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/portal/settings',
      tags: ['portal'],
      summary: 'Turn customer pages on or off, and set the defaults',
      security,
      middleware: [requirePermission('settings', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  enabled: z.boolean().optional(),
                  linkDays: z.number().int().min(1).max(730).optional(),
                  statements: z.boolean().optional(),
                  questions: z.boolean().optional(),
                })
                .openapi('PortalSettingsInput'),
            },
          },
        },
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const { businessId, ...patch } = c.req.valid('json');
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      return c.json(
        (await run(() =>
          svc().saveSettings(orgOf(c as never).id, businessId, clean, userOf(c as never)),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/portal/links',
      tags: ['portal'],
      summary:
        'A customer link to one invoice, or to one party’s statement; the address is in the answer',
      security,
      middleware: [requirePermission('sales', 'export')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  documentId: z.string().uuid().optional(),
                  partyId: z.string().uuid().optional(),
                  days: z.number().int().min(1).max(730).optional(),
                })
                .refine(
                  (b) => !!b.documentId !== !!b.partyId,
                  'Give a document or a party, not both.',
                )
                .openapi('PortalLinkInput'),
            },
          },
        },
      },
      responses: { 201: json(any, 'Made'), ...errors, 410: json(errorSchema, 'Turned off') },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        (await run(() =>
          svc().createLink({ ...b, orgId: orgOf(c as never).id, by: userOf(c as never) }),
        )) as never,
        201,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/portal/links',
      tags: ['portal'],
      summary: 'The links of a document, a party, or the business',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: {
        params: orgParam,
        query: businessQuery.extend({
          documentId: z.string().uuid().optional(),
          partyId: z.string().uuid().optional(),
        }),
      },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        (await run(() => svc().links(orgOf(c as never).id, q.businessId, q))) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/portal/links/{linkId}',
      tags: ['portal'],
      summary: 'Withdraw a link; the page says so from the next request',
      security,
      middleware: [requirePermission('sales', 'export')] as const,
      request: {
        params: orgParam.extend({
          linkId: z
            .string()
            .uuid()
            .openapi({ param: { name: 'linkId', in: 'path' } }),
        }),
      },
      responses: { 200: json(any, 'Revoked'), ...errors },
    }),
    async (c) => {
      const { linkId } = c.req.valid('param') as { linkId: string };
      return c.json(
        (await run(() => svc().revoke(orgOf(c as never).id, linkId, userOf(c as never)))) as never,
        200,
      );
    },
  );

  app.route('/v1/orgs/:orgId', r as never);

  /* ----------------------------------------------------------------------------- the customer */

  const pub = subApp();
  pub.use('*', async (c, next) => {
    // the API's per-address limit applies too; this one is tighter, and counts per token as well
    const ip = await limiters.ip.take(`portal:ip:${clientIp(c, deps.config.trustProxy)}`);
    const tok = await limiters.token.take(`portal:tok:${c.req.param('token') ?? ''}`);
    if (!ip.ok || !tok.ok) {
      c.header('retry-after', String(Math.ceil(Math.max(ip.resetMs, tok.resetMs) / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
    c.header('cache-control', 'no-store');
    c.header('x-robots-tag', 'noindex');
    await next();
  });

  pub.openapi(
    createRoute({
      method: 'get',
      path: '/{token}',
      tags: ['portal'],
      summary: 'The invoice or statement a customer link shows',
      request: { params: tokenParam },
      responses: { 200: json(any), ...publicErrors },
    }),
    async (c) => c.json((await run(() => svc().page(c.req.valid('param').token))) as never, 200),
  );

  pub.openapi(
    createRoute({
      method: 'get',
      path: '/{token}/pdf',
      tags: ['portal'],
      summary: 'The PDF of the invoice',
      request: { params: tokenParam },
      responses: {
        200: { description: 'The PDF', content: { 'application/pdf': { schema: z.string() } } },
        ...publicErrors,
      },
    }),
    async (c) => {
      const out = await run(() => svc().pdf(c.req.valid('param').token));
      c.header('content-type', 'application/pdf');
      c.header('content-disposition', `attachment; filename="${out.fileName}"`);
      return c.body(Buffer.from(out.bytes), 200) as never;
    },
  );

  pub.openapi(
    createRoute({
      method: 'post',
      path: '/{token}/pay',
      tags: ['portal'],
      summary: 'A payment link for what is still owed on the invoice',
      request: { params: tokenParam },
      responses: {
        200: json(z.object({ url: z.string(), amountPaise: z.number(), expiresAt: z.number() })),
        ...publicErrors,
      },
    }),
    async (c) => c.json(await run(() => svc().pay(c.req.valid('param').token)), 200),
  );

  pub.openapi(
    createRoute({
      method: 'post',
      path: '/{token}/question',
      tags: ['portal'],
      summary: 'A question or dispute from the customer, for the owner’s inbox',
      request: {
        params: tokenParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  name: z.string().trim().max(120).nullable().default(null),
                  contact: z.string().trim().max(120).nullable().default(null),
                  text: z.string().trim().min(1).max(2000),
                })
                .openapi('PortalQuestion'),
            },
          },
        },
      },
      responses: {
        201: json(z.object({ ok: z.literal(true) }), 'Sent'),
        ...publicErrors,
        422: json(errorSchema, 'Refused'),
      },
    }),
    async (c) => {
      await run(() => svc().question(c.req.valid('param').token, c.req.valid('json')));
      return c.json({ ok: true as const }, 201);
    },
  );

  app.route('/v1/p', pub as never);
}
