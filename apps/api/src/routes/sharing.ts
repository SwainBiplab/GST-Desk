/**
 * Sharing and the accountant's side (prompt 47). Under an organisation: the owner's shares of a business
 * (`team` permissions), and the client routes an accountant reads through (members with the same view rights
 * may use them too): the overview, documents inside the shared dates, one document and its PDF, comments to
 * the owner's inbox, and export packs. For the signed-in account: shares waiting for it, accept or decline, and
 * the list of clients.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { subApp, type App } from '../app';
import { ApiError, errorSchema, forbidden, notFound, unauthorized } from '../errors';
import { boardRow } from '../filing/board';
import { renderDocumentPdf } from '../messaging/pdf';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';
import {
  ClientError,
  addComment,
  clientDocument,
  clientDocuments,
  clientsOf,
  comments,
  spanOf,
} from '../portals/clients';
import { PackError, type ExportPackService } from '../portals/export-pack';
import { ShareError, fyRange, type ShareService } from '../portals/shares';

import { phoneEmail } from './team';

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
  409: json(errorSchema, 'Conflicts with the current state'),
  410: json(errorSchema, 'Expired'),
  422: json(errorSchema, 'Refused by a rule'),
  503: json(errorSchema, 'Not set up on this server'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const withId = (name: string) =>
  orgParam.extend({
    [name]: z
      .string()
      .uuid()
      .openapi({ param: { name, in: 'path' } }),
  });
const any = z.record(z.string(), z.unknown());
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const businessQuery = z.object({ businessId: z.string().uuid() });
const sharePermsSchema = z
  .object({
    read: z.boolean().default(true),
    gst: z.boolean().default(true),
    export: z.boolean().default(false),
    comment: z.boolean().default(true),
  })
  .openapi('SharePerms');

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};
const ctxOf = (c: Ctx, businessId: string) => ({
  orgId: orgOf(c).id,
  businessId,
  actor: userOf(c),
  deviceId: 'api',
});

const SHARE_STATUS = { validation: 422, conflict: 409, not_found: 404, expired: 410 } as const;
const CLIENT_STATUS = { not_found: 404, forbidden: 403, validation: 422 } as const;
const PACK_STATUS = { not_found: 404, no_storage: 503, validation: 422, not_ready: 409 } as const;
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ShareError)
      throw new ApiError(SHARE_STATUS[e.code], `share_${e.code}`, e.message);
    if (e instanceof ClientError)
      throw new ApiError(CLIENT_STATUS[e.code], `client_${e.code}`, e.message);
    if (e instanceof PackError)
      throw new ApiError(PACK_STATUS[e.code], `pack_${e.code}`, e.message);
    throw e;
  }
}

export function sharingRoutes(app: App, deps: RouteDeps): void {
  const shares = (): ShareService => {
    if (!deps.portals) throw new ApiError(503, 'no_portals', 'Sharing is not available here.');
    return deps.portals.shares;
  };
  const packs = (): ExportPackService => {
    if (!deps.portals) throw new ApiError(503, 'no_portals', 'Sharing is not available here.');
    return deps.portals.packs;
  };
  const nameOf = async (userId: string) => {
    const [u] = await deps.db.sql`SELECT name, email FROM auth_user WHERE id = ${userId}`;
    return {
      name: String(u?.['name'] || u?.['email'] || 'Someone'),
      email: String(u?.['email'] ?? ''),
    };
  };

  const r = subApp();
  r.use('*', requireOrg as never);

  /* ------------------------------------------------------------------------ the owner's shares */

  r.openapi(
    createRoute({
      method: 'get',
      path: '/shares',
      tags: ['sharing'],
      summary: 'Who a business is shared with',
      security,
      middleware: [requirePermission('team', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          shares().list(orgOf(c as never).id, c.req.valid('query').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/shares',
      tags: ['sharing'],
      summary:
        'Share a business, read-only, with an accountant for a financial year or a span of dates',
      security,
      middleware: [requirePermission('team', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  email: z.string().trim().email().max(200).optional(),
                  phone: z
                    .string()
                    .trim()
                    .regex(/^\+?[0-9]{10,15}$/)
                    .optional(),
                  /** `2026-27`, or `from` and `to`. */
                  fy: z.string().optional(),
                  from: iso.optional(),
                  to: iso.optional(),
                  perms: sharePermsSchema.optional(),
                  /** When the access itself ends; null for until revoked. */
                  expiresAt: z.number().int().positive().nullable().default(null),
                  note: z.string().trim().max(500).nullable().default(null),
                })
                .refine((b) => !!b.email || !!b.phone, 'Give an e-mail or a phone number.')
                .refine((b) => !!b.fy || (!!b.from && !!b.to), 'Give a financial year or dates.')
                .openapi('ShareInput'),
            },
          },
        },
      },
      responses: { 201: json(any, 'Shared'), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const b = c.req.valid('json');
      const email = b.email ?? phoneEmail(b.phone!);
      const [biz] = await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        return tx`SELECT fy_start_month FROM businesses WHERE id = ${b.businessId} AND deleted_at IS NULL`;
      });
      if (!biz) throw notFound('That business');
      const span = b.fy
        ? await run(async () => fyRange(b.fy!, Number(biz['fy_start_month'] ?? 4)))
        : { from: b.from!, to: b.to! };
      const made = await run(() =>
        shares().create({
          orgId: o.id,
          businessId: b.businessId,
          email,
          ...span,
          perms: b.perms ?? { read: true, gst: true, export: false, comment: true },
          expiresAt: b.expiresAt,
          note: b.note,
          by: userOf(c as never),
        }),
      );
      // a note to the accountant: they accept after signing in with that address or number
      await deps.otp
        .send({
          kind: b.phone ? 'phone' : 'email',
          to: b.phone ?? email,
          code: made.id,
          purpose: `share:${o.name}`,
        })
        .catch(() => undefined);
      return c.json(made as never, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/shares/{shareId}',
      tags: ['sharing'],
      summary: 'Revoke a share; the accountant loses access from their next request',
      security,
      middleware: [requirePermission('team', 'edit')] as const,
      request: { params: withId('shareId') },
      responses: { 200: json(any, 'Revoked'), ...errors },
    }),
    async (c) => {
      const { shareId } = c.req.valid('param') as { shareId: string };
      return c.json(
        (await run(() =>
          shares().revoke(orgOf(c as never).id, shareId, userOf(c as never)),
        )) as never,
        200,
      );
    },
  );

  /* ---------------------------------------------------------------------- the accountant's side */

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/overview',
      tags: ['client'],
      summary:
        'A client as the accountant sees it: profile, filing cells, exceptions, what was shared',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const { businessId } = c.req.valid('query');
      const [b] = await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        return tx`SELECT id, trade_name, legal_name, gstin, state_code, address, scheme, fy_start_month FROM businesses WHERE id = ${businessId} AND deleted_at IS NULL`;
      });
      if (!b) throw notFound('That business');
      const ctx = ctxOf(c as never, businessId);
      const gst = c.get('org').perms.grants['gst']?.includes('view');
      const row = gst
        ? await boardRow(deps.db, o.id, o.name, b, Date.now(), ctx)
        : { cells: [], exceptions: [] };
      const span = spanOf(o.share);
      const [counts] = await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        return tx`SELECT count(*) FILTER (WHERE type IN ('tax_invoice', 'bill_of_supply'))::int AS sales,
                         count(*) FILTER (WHERE type IN ('purchase_bill'))::int AS purchases,
                         count(*) FILTER (WHERE type IN ('credit_note', 'debit_note'))::int AS notes,
                         count(*)::int AS all
                  FROM documents WHERE business_id = ${businessId} AND status <> 'draft' AND deleted_at IS NULL
                    AND date >= ${span.from} AND date <= ${span.to}`;
      });
      return c.json(
        {
          business: {
            id: String(b['id']),
            name: String(b['trade_name'] || b['legal_name']),
            legalName: String(b['legal_name']),
            gstin: (b['gstin'] as string | null) ?? null,
            stateCode: String(b['state_code'] ?? ''),
            scheme: String(b['scheme'] ?? 'regular'),
            fyStartMonth: Number(b['fy_start_month'] ?? 4),
          },
          access: o.share
            ? { via: 'share', from: o.share.from, to: o.share.to, perms: o.share.perms }
            : { via: 'member', from: null, to: null, perms: null },
          cells: row.cells,
          exceptions: row.exceptions,
          counts: {
            sales: Number(counts?.['sales'] ?? 0),
            purchases: Number(counts?.['purchases'] ?? 0),
            notes: Number(counts?.['notes'] ?? 0),
            all: Number(counts?.['all'] ?? 0),
          },
        } as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/documents',
      tags: ['client'],
      summary: 'The client’s issued documents inside the shared dates',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: {
        params: orgParam,
        query: businessQuery.extend({
          from: iso.optional(),
          to: iso.optional(),
          type: z.string().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        (await clientDocuments(
          deps.db,
          ctxOf(c as never, q.businessId),
          orgOf(c as never).share ?? null,
          q,
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/documents/{documentId}',
      tags: ['client'],
      summary: 'One document with its lines',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: withId('documentId'), query: businessQuery },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const { documentId } = c.req.valid('param') as { documentId: string };
      const { businessId } = c.req.valid('query');
      const d = await clientDocument(
        deps.db,
        ctxOf(c as never, businessId),
        orgOf(c as never).share ?? null,
        documentId,
      );
      if (!d) throw notFound('That document');
      return c.json(d as never, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/documents/{documentId}/pdf',
      tags: ['client'],
      summary: 'The PDF of one document',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: withId('documentId'), query: businessQuery },
      responses: {
        200: { description: 'The PDF', content: { 'application/pdf': { schema: z.string() } } },
        ...errors,
      },
    }),
    async (c) => {
      const { documentId } = c.req.valid('param') as { documentId: string };
      const { businessId } = c.req.valid('query');
      const ctx = ctxOf(c as never, businessId);
      const d = await clientDocument(deps.db, ctx, orgOf(c as never).share ?? null, documentId);
      if (!d) throw notFound('That document');
      const out = await renderDocumentPdf(deps.db, ctx, documentId);
      if (!out) throw notFound('That document');
      c.header('content-type', 'application/pdf');
      c.header('content-disposition', `inline; filename="${out.fileName}"`);
      return c.body(Buffer.from(out.bytes), 200) as never;
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/comments',
      tags: ['client'],
      summary: 'Comments on this client, newest first',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) =>
      c.json(
        (await comments(deps.db, ctxOf(c as never, c.req.valid('query').businessId))) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/client/comments',
      tags: ['client'],
      summary:
        'Leave a comment for the owner (it lands in their inbox); the only write a share allows',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  documentId: z.string().uuid().nullable().default(null),
                  text: z.string().trim().min(1).max(2000),
                })
                .openapi('CommentInput'),
            },
          },
        },
      },
      responses: { 201: json(any, 'Commented'), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      if (o.share && !o.share.perms.comment) throw forbidden('This share does not allow comments.');
      const b = c.req.valid('json');
      const { name } = await nameOf(userOf(c as never));
      const made = await run(() =>
        addComment(deps.db, ctxOf(c as never, b.businessId), o.share ?? null, {
          documentId: b.documentId,
          text: b.text,
          byName: name,
        }),
      );
      deps.notify?.org(o.id, { kind: 'inbox' }, { roles: ['owner', 'admin'] });
      return c.json(made as never, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/client/export-packs',
      tags: ['client'],
      summary:
        'Build an export pack (registers, return files, Tally XML, statements, PDFs) for a span of dates',
      security,
      middleware: [requirePermission('reports', 'export')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({ businessId: z.string().uuid(), from: iso, to: iso })
                .openapi('ExportPackInput'),
            },
          },
        },
      },
      responses: { 202: json(any, 'Building'), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const b = c.req.valid('json');
      if (o.share && (b.from < o.share.from || b.to > o.share.to))
        throw forbidden('Those dates are outside what was shared with you.');
      const made = await run(() =>
        packs().request({
          orgId: o.id,
          businessId: b.businessId,
          from: b.from,
          to: b.to,
          shareId: o.share?.id ?? null,
          by: userOf(c as never),
        }),
      );
      return c.json(made as never, 202);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/export-packs',
      tags: ['client'],
      summary: 'Export packs asked for, newest first',
      security,
      middleware: [requirePermission('reports', 'export')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          packs().list(orgOf(c as never).id, c.req.valid('query').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/client/export-packs/{packId}/download',
      tags: ['client'],
      summary: 'A signed address for a finished pack (valid for ten minutes)',
      security,
      middleware: [requirePermission('reports', 'export')] as const,
      request: { params: withId('packId') },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.number() })), ...errors },
    }),
    async (c) => {
      const { packId } = c.req.valid('param') as { packId: string };
      return c.json(await run(() => packs().download(orgOf(c as never).id, packId)), 200);
    },
  );

  app.route('/v1/orgs/:orgId', r as never);

  /* -------------------------------------------------------------------- the signed-in account */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/share-invites',
      tags: ['sharing'],
      summary: 'Businesses offered to this account, waiting for an answer',
      security,
      responses: { 200: json(z.array(any)), 401: json(errorSchema, 'Not signed in') },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const { email } = await nameOf(s.userId);
      return c.json((await shares().invitesFor(email)) as never, 200);
    },
  );

  for (const accept of [true, false]) {
    app.openapi(
      createRoute({
        method: 'post',
        path: `/v1/share-invites/{shareId}/${accept ? 'accept' : 'decline'}`,
        tags: ['sharing'],
        summary: accept ? 'Take up a shared business' : 'Turn a share down',
        security,
        request: {
          params: z.object({
            shareId: z
              .string()
              .uuid()
              .openapi({ param: { name: 'shareId', in: 'path' } }),
          }),
        },
        responses: {
          200: json(z.object({ orgId: z.string(), businessId: z.string() })),
          401: json(errorSchema, 'Not signed in'),
          404: json(errorSchema, 'Not found'),
          410: json(errorSchema, 'Expired'),
        },
      }),
      async (c) => {
        const s = c.get('session');
        if (!s) throw unauthorized();
        const { shareId } = c.req.valid('param');
        const { email } = await nameOf(s.userId);
        return c.json(
          await run(() => shares().answer(shareId, { id: s.userId, email }, accept)),
          200,
        );
      },
    );
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/clients',
      tags: ['sharing'],
      summary: 'Every business this account can read: shared with it, or of its own organisations',
      security,
      responses: { 200: json(z.array(any)), 401: json(errorSchema, 'Not signed in') },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      return c.json((await clientsOf(deps.db, s.userId, Date.now())) as never, 200);
    },
  );
}
