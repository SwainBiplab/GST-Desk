/**
 * Payment collection routes (prompt 45): connect the business's gateway account, make a payment link or a UPI QR
 * for an invoice, see what came in, payouts, and refunds out of credit notes (which a second person approves).
 * Permissions come from the shared matrix: connecting and approving refunds is `payments.approve`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { subApp, type App } from '../app';
import { ApiError, errorSchema, unauthorized } from '../errors';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';
import { PaymentsError, type PaymentsService } from '../payments/service';

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
  422: json(errorSchema, 'Refused by a rule'),
  502: json(errorSchema, 'The gateway refused or could not be reached'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const idParam = (name: string) =>
  orgParam.extend({
    [name]: z
      .string()
      .uuid()
      .openapi({ param: { name, in: 'path' } }),
  });
const any = z.record(z.string(), z.unknown());
const list = z.array(any);
const businessQuery = z.object({ businessId: z.string().uuid() });

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};

const STATUS: Record<PaymentsError['code'], number> = {
  no_key: 503,
  no_gateway: 409,
  no_document: 404,
  not_payable: 422,
  not_found: 404,
  rule: 422,
  gateway: 502,
};
/** The service's refusals as the API's errors. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PaymentsError)
      throw new ApiError(STATUS[e.code], `payments_${e.code}`, e.message);
    throw e;
  }
}

export function paymentsRoutes(app: App, deps: RouteDeps): void {
  const svc = (): PaymentsService => {
    if (!deps.payments)
      throw new ApiError(503, 'no_payments', 'Payment collection is not available on this server.');
    return deps.payments;
  };
  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/gateway',
      tags: ['payments'],
      summary:
        'Whether the business has a gateway connected, in test or live mode, and its last error',
      security,
      middleware: [requirePermission('payments', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(any), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          svc().status(orgOf(c as never).id, c.req.valid('query').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/payments/gateway',
      tags: ['payments'],
      summary:
        'Connect the business’s Razorpay account; the secrets are sealed and never shown again',
      security,
      middleware: [requirePermission('payments', 'approve')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                keyId: z
                  .string()
                  .trim()
                  .regex(/^rzp_(test|live)_[A-Za-z0-9]{6,}$/, 'That is not a Razorpay key id'),
                keySecret: z.string().min(8).max(200),
                webhookSecret: z.string().min(6).max(200),
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
        (await run(() => svc().connect(orgOf(c as never).id, b.businessId, b))) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/payments/gateway',
      tags: ['payments'],
      summary: 'Disconnect the gateway: no new links or QR codes; what was paid stays recorded',
      security,
      middleware: [requirePermission('payments', 'approve')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 204: { description: 'Disconnected' }, ...errors },
    }),
    async (c) => {
      await run(() => svc().disconnect(orgOf(c as never).id, c.req.valid('query').businessId));
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/requests',
      tags: ['payments'],
      summary: 'A payment link or a one-time UPI QR for what is owed on an invoice',
      security,
      middleware: [requirePermission('payments', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                documentId: z.string().uuid(),
                kind: z.enum(['link', 'qr']),
                partialAllowed: z.boolean().optional(),
                expiresInDays: z.number().int().min(1).max(60).optional(),
              }),
            },
          },
        },
      },
      responses: { 201: json(any), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const o = orgOf(c as never);
      const out = await run(() =>
        svc().createRequest({ orgId: o.id, ...b, by: userOf(c as never) }),
      );
      return c.json(out as never, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/requests',
      tags: ['payments'],
      summary: 'The links and QR codes made for an invoice, newest first',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam, query: z.object({ documentId: z.string().uuid() }) },
      responses: { 200: json(list), ...errors },
    }),
    async (c) =>
      c.json(
        (await svc().requestsFor(orgOf(c as never).id, c.req.valid('query').documentId)) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/requests/{requestId}',
      tags: ['payments'],
      summary: 'One request and whether it has been paid (the Show QR screen polls this)',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: idParam('requestId') },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const { requestId } = c.req.valid('param') as { requestId: string };
      return c.json(
        (await run(() => svc().request(orgOf(c as never).id, requestId))) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/requests/cancel',
      tags: ['payments'],
      summary: 'Close the open links and QR codes of an invoice (cancelled, or paid another way)',
      security,
      middleware: [requirePermission('payments', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({ businessId: z.string().uuid(), documentId: z.string().uuid() }),
            },
          },
        },
      },
      responses: { 200: json(z.object({ closed: z.number() })), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        { closed: await svc().cancelRequests(orgOf(c as never).id, b.businessId, b.documentId) },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/online',
      tags: ['payments'],
      summary:
        'Payments that came in through the gateway, with their fee and whether an invoice took them',
      security,
      middleware: [requirePermission('payments', 'view')] as const,
      request: {
        params: orgParam,
        query: businessQuery.extend({
          status: z.enum(['received', 'matched', 'unmatched']).optional(),
        }),
      },
      responses: { 200: json(list), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        (await svc().gatewayPayments(orgOf(c as never).id, q.businessId, q.status)) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/settlements',
      tags: ['payments'],
      summary: 'Payouts the gateway made, and whether the payments we hold add up to each',
      security,
      middleware: [requirePermission('payments', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(list), ...errors },
    }),
    async (c) =>
      c.json(
        (await svc().settlements(orgOf(c as never).id, c.req.valid('query').businessId)) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/settlements/sync',
      tags: ['payments'],
      summary: 'Fetch the last 30 days of payouts from the gateway',
      security,
      middleware: [requirePermission('payments', 'create')] as const,
      request: {
        params: orgParam,
        body: { content: { 'application/json': { schema: businessQuery } } },
      },
      responses: { 200: json(list), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          svc().syncSettlements(orgOf(c as never).id, c.req.valid('json').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/payments/refunds',
      tags: ['payments'],
      summary: 'Refunds asked for, waiting for a second person, and done',
      security,
      middleware: [requirePermission('payments', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(list), ...errors },
    }),
    async (c) =>
      c.json(
        (await svc().refunds(orgOf(c as never).id, c.req.valid('query').businessId)) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/refunds',
      tags: ['payments'],
      summary:
        'Ask to pay a customer back from an online payment, out of one of their credit notes',
      security,
      middleware: [requirePermission('payments', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                gatewayPaymentId: z.string().uuid(),
                creditNoteId: z.string().uuid(),
                amountPaise: z.number().int().positive(),
              }),
            },
          },
        },
      },
      responses: { 201: json(z.object({ id: z.string() })), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const id = await run(() =>
        svc().requestRefund({ orgId: orgOf(c as never).id, ...b, by: userOf(c as never) }),
      );
      return c.json({ id }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/refunds/{refundId}/approve',
      tags: ['payments'],
      summary:
        'Approve a refund: the gateway pays it and the books record it. Not by the person who asked.',
      security,
      middleware: [requirePermission('payments', 'approve')] as const,
      request: { params: idParam('refundId') },
      responses: { 200: json(z.object({ status: z.string() })), ...errors },
    }),
    async (c) => {
      const { refundId } = c.req.valid('param') as { refundId: string };
      return c.json(
        await run(() => svc().approveRefund(orgOf(c as never).id, refundId, userOf(c as never))),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/payments/refunds/{refundId}/reject',
      tags: ['payments'],
      summary: 'Turn a refund down',
      security,
      middleware: [requirePermission('payments', 'approve')] as const,
      request: { params: idParam('refundId') },
      responses: { 204: { description: 'Rejected' }, ...errors },
    }),
    async (c) => {
      const { refundId } = c.req.valid('param') as { refundId: string };
      await run(() => svc().rejectRefund(orgOf(c as never).id, refundId, userOf(c as never)));
      return c.body(null, 204);
    },
  );

  app.route('/v1/orgs/:orgId', r as never);
}
