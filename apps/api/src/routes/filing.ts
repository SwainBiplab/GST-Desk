/**
 * GST filing routes (prompt 46): the portal login (OTP typed by the taxpayer), jobs that save a return on the portal,
 * pull 2B and 2A and ask about filing, the Filing Desk's late-fee and nil figures, a pack of the return files for a
 * period, and the CA's board across organisations. Permissions use the shared matrix's `gst` module.
 */
import { GstrRepo } from '@gst/db';
import { gstr1Json, gstr3bJson, type Return } from '@gst/domain';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { subApp, type App } from '../app';
import { ApiError, errorSchema, unauthorized } from '../errors';
import { filingBoard } from '../filing/board';
import { FilingError, type FilingService } from '../filing/service';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';

import type { RouteDeps } from './index';

const security = [{ bearer: [] }, { cookie: [] }];
const json = <T extends z.ZodTypeAny>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  401: json(errorSchema, 'Not signed in'),
  402: json(errorSchema, 'Not on the plan'),
  403: json(errorSchema, 'Not allowed for this role'),
  404: json(errorSchema, 'Not found'),
  422: json(errorSchema, 'Refused by a rule'),
  502: json(errorSchema, 'The portal refused or could not be reached'),
  503: json(errorSchema, 'Not set up on this server'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const any = z.record(z.string(), z.unknown());
const businessQuery = z.object({ businessId: z.string().uuid() });
const fp = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/);

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};

const STATUS: Record<FilingError['code'], number> = {
  no_gsp: 503,
  no_key: 503,
  plan: 402,
  limit: 402,
  no_session: 409,
  not_found: 404,
  rule: 422,
  portal: 502,
};
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FilingError) throw new ApiError(STATUS[e.code], `filing_${e.code}`, e.message);
    throw e;
  }
}

export function filingRoutes(app: App, deps: RouteDeps): void {
  const svc = (): FilingService => {
    if (!deps.filing)
      throw new ApiError(
        503,
        'no_filing',
        'Filing through the GSP is not available on this server.',
      );
    return deps.filing;
  };
  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/filing/status',
      tags: ['filing'],
      summary: 'The plan, the GSP in use, the portal login, and the latest jobs of a business',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const b = c.req.valid('query').businessId;
      return c.json(
        {
          entitlement: await svc().entitlement(o.id),
          session: await svc().sessionState(o.id, b),
          jobs: await svc().jobs(o.id, b, 20),
        } as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/filing/otp',
      tags: ['filing'],
      summary: 'Ask the portal to send an OTP to the taxpayer’s registered number',
      security,
      middleware: [requirePermission('gst', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                username: z.string().trim().min(2).max(60),
              }),
            },
          },
        },
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        (await run(() =>
          svc().requestOtp(orgOf(c as never).id, b.businessId, b.username, userOf(c as never)),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/filing/otp/verify',
      tags: ['filing'],
      summary: 'The OTP the taxpayer typed in: opens a portal session for about six hours',
      security,
      middleware: [requirePermission('gst', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                otp: z.string().regex(/^\d{4,8}$/),
              }),
            },
          },
        },
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        (await run(() =>
          svc().verifyOtp(orgOf(c as never).id, b.businessId, b.otp, userOf(c as never)),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/filing/session',
      tags: ['filing'],
      summary: 'Forget the portal session now',
      security,
      middleware: [requirePermission('gst', 'edit')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 204: { description: 'Signed out' }, ...errors },
    }),
    async (c) => {
      await svc().signOut(orgOf(c as never).id, c.req.valid('query').businessId);
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/filing/jobs',
      tags: ['filing'],
      summary: 'Save a return on the portal, pull 2B or 2A, or ask whether a return is filed',
      security,
      middleware: [requirePermission('gst', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                kind: z.enum(['push', 'pull_2b', 'pull_2a', 'poll_filing']),
                form: z.enum(['gstr1', 'gstr3b', 'iff']).optional(),
                period: fp,
              }),
            },
          },
        },
      },
      responses: { 202: json(z.object({ id: z.string(), existing: z.boolean() })), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      if (b.kind === 'push' && b.form === 'gstr3b')
        throw new ApiError(
          422,
          'filing_rule',
          'GSTR-3B is not saved through the GSP yet; export it and file on the portal.',
        );
      const out = await run(() =>
        svc().start({
          orgId: orgOf(c as never).id,
          businessId: b.businessId,
          kind: b.kind,
          form: b.form ?? null,
          fp: b.period,
          by: userOf(c as never),
        }),
      );
      return c.json(out, 202);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/filing/jobs',
      tags: ['filing'],
      summary: 'The latest filing jobs of a business, newest first',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) =>
      c.json(
        (await svc().jobs(orgOf(c as never).id, c.req.valid('query').businessId)) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/filing/desk',
      tags: ['filing'],
      summary: 'The due date, late-fee estimate and nil flag of one return',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: {
        params: orgParam,
        query: businessQuery.extend({ ret: z.enum(['gstr1', 'gstr3b']), period: fp }),
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const out = await run(() =>
        svc().deskInfo(orgOf(c as never).id, q.businessId, q.ret as Return, q.period),
      );
      return c.json(
        {
          ...out,
          lateFee: {
            ...out.lateFee,
            perDayPaise: Number(out.lateFee.perDayPaise),
            capPaise: Number(out.lateFee.capPaise),
            feePaise: Number(out.lateFee.feePaise),
          },
        } as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/filing/pack',
      tags: ['filing'],
      summary:
        'The GSTR-1 and GSTR-3B files of a period, ready to hand to the client or the portal',
      security,
      middleware: [requirePermission('gst', 'export')] as const,
      request: { params: orgParam, query: businessQuery.extend({ period: fp }) },
      responses: {
        200: json(
          z.object({ files: z.array(z.object({ name: z.string(), content: z.string() })) }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const q = c.req.valid('query');
      const ctx = {
        orgId: o.id,
        businessId: q.businessId,
        actor: userOf(c as never),
        deviceId: 'api',
      };
      const gr = new GstrRepo(deps.db);
      const info = await gr.businessInfo(ctx);
      const period = await run(() => svc().periodFor(o.id, q.businessId, q.period));
      // the same gate as the desk's own export: nothing leaves with problems standing
      const review = await run(() =>
        gr.assertExportable(ctx, period).catch((e: Error) => {
          throw new FilingError(e.message, 'rule');
        }),
      );
      return c.json(
        {
          files: [
            {
              name: `GSTR1_${info.gstin}_${q.period}.json`,
              content: JSON.stringify(gstr1Json(review.gstr1), null, 2),
            },
            {
              name: `GSTR3B_${info.gstin}_${q.period}.json`,
              content: JSON.stringify(gstr3bJson(review.gstr3b), null, 2),
            },
          ],
        },
        200,
      );
    },
  );

  app.route('/v1/orgs/:orgId', r as never);

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/filing-board',
      tags: ['filing'],
      summary:
        'Every business the account can see: a cell per period and return, and what needs a look',
      security,
      request: {
        query: z.object({ itcThresholdPaise: z.coerce.number().int().min(0).optional() }),
      },
      responses: { 200: json(any), 401: json(errorSchema, 'Not signed in') },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const t = c.req.valid('query').itcThresholdPaise;
      return c.json(
        (await filingBoard(
          deps.db,
          s.userId,
          Date.now(),
          t === undefined ? {} : { itcThresholdPaise: t },
        )) as never,
        200,
      );
    },
  );
}
