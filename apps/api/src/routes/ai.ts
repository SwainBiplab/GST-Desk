/**
 * The cloud AI gateway's routes (prompt 48), under `/v1/orgs/:orgId/ai`. Each one needs the right permission
 * for what it reads, the plan and the month's quota, and answers with the result, the tokens used and the
 * quota (with its 80% warning) so the app can say so. Files arrive base64 in the JSON body (the API's body
 * limit applies); bills are usually sent as the text the device already read.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { AiGatewayError, type AiGatewayService } from '../ai/service';
import { subApp, type App } from '../app';
import { ApiError, errorSchema, unauthorized } from '../errors';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';

import type { RouteDeps } from './index';

const security = [{ bearer: [] }, { cookie: [] }];
const json = <T extends z.ZodTypeAny>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  401: json(errorSchema, 'Not signed in'),
  402: json(errorSchema, 'Not on the plan, or the month’s tokens are used up'),
  403: json(errorSchema, 'Not allowed for this role'),
  404: json(errorSchema, 'Not found'),
  422: json(errorSchema, 'The model declined or answered out of shape'),
  502: json(errorSchema, 'The cloud model could not be reached'),
  503: json(errorSchema, 'Cloud AI is not set up on this server'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const any = z.record(z.string(), z.unknown());
const businessQuery = z.object({ businessId: z.string().uuid() });
const fileSchema = z
  .object({
    name: z.string().max(200),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']),
    base64: z.string().max(2_000_000),
  })
  .openapi('AiFile');

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};
const STATUS: Record<AiGatewayError['code'], number> = {
  no_provider: 503,
  plan: 402,
  quota: 402,
  refused: 422,
  invalid: 422,
  unavailable: 502,
  not_found: 404,
  validation: 422,
};
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiGatewayError) throw new ApiError(STATUS[e.code], `ai_${e.code}`, e.message);
    throw e;
  }
}
const bytesOf = (f: { name: string; mime: string; base64: string } | undefined) =>
  f
    ? { name: f.name, mime: f.mime, bytes: new Uint8Array(Buffer.from(f.base64, 'base64')) }
    : undefined;

export function aiRoutes(app: App, deps: RouteDeps): void {
  const svc = (): AiGatewayService => {
    if (!deps.ai)
      throw new ApiError(503, 'ai_no_provider', 'Cloud AI is not set up on this server.');
    return deps.ai;
  };
  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/status',
      tags: ['ai'],
      summary:
        'Whether cloud AI is on for this organisation, and the month’s tokens used and allowed',
      security,
      request: { params: orgParam },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      if (!deps.ai)
        return c.json(
          { enabled: false, used: 0, limit: 0, warning: false, configured: false },
          200,
        );
      const q = await deps.ai.quota(orgOf(c as never).id);
      return c.json({ ...q, configured: true } as never, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/extract-bill',
      tags: ['ai'],
      summary: 'Read a purchase bill with the cloud model: its text, or the image or PDF itself',
      security,
      middleware: [requirePermission('purchases', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  text: z.string().max(60_000).optional(),
                  file: fileSchema.optional(),
                })
                .refine((b) => !!b.text?.trim() || !!b.file, 'Send the bill’s text or the file.')
                .openapi('ExtractBillInput'),
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
          svc().extractBill(orgOf(c as never).id, b.businessId, userOf(c as never), {
            text: b.text,
            file: bytesOf(b.file),
          }),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/explain-mismatch',
      tags: ['ai'],
      summary: 'Why a GSTR-2B entry and a book bill disagree, and what to do',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({ businessId: z.string().uuid(), row: any })
                .openapi('ExplainMismatchInput'),
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
          svc().explainMismatch(orgOf(c as never).id, b.businessId, userOf(c as never), b.row),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/summarise-notice',
      tags: ['ai'],
      summary: 'A GST notice summarised: what it is, the dates, the demand, what it asks for',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  text: z.string().max(120_000).optional(),
                  file: fileSchema.optional(),
                })
                .refine((b) => !!b.text?.trim() || !!b.file, 'Send the notice’s text or the PDF.')
                .openapi('SummariseNoticeInput'),
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
          svc().summariseNotice(orgOf(c as never).id, b.businessId, userOf(c as never), {
            text: b.text,
            file: bytesOf(b.file),
          }),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/ask-books',
      tags: ['ai'],
      summary: 'Ask a question of the business’s own books; answered over read-only report tools',
      security,
      middleware: [requirePermission('reports', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  question: z.string().trim().min(1).max(2000),
                  history: z
                    .array(
                      z.object({
                        role: z.enum(['user', 'assistant']),
                        content: z.string().max(8000),
                      }),
                    )
                    .max(20)
                    .default([]),
                })
                .openapi('AskBooksInput'),
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
          svc().askBooks(
            orgOf(c as never).id,
            b.businessId,
            userOf(c as never),
            b.question,
            b.history,
          ),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/gst-qa',
      tags: ['ai'],
      summary:
        'A GST question answered over the curated corpus, with sources and the not-legal-advice line',
      security,
      middleware: [requirePermission('gst', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  question: z.string().trim().min(1).max(2000),
                })
                .openapi('GstQaInput'),
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
          svc().gstQa(orgOf(c as never).id, b.businessId, userOf(c as never), b.question),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/draft-message',
      tags: ['ai'],
      summary: 'Draft a short customer message in the language asked for',
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
                  kind: z.enum(['invoice', 'reminder', 'receipt', 'thanks', 'custom']),
                  language: z.string().max(20).default('en'),
                  context: z.record(z.string(), z.unknown()).default({}),
                })
                .openapi('DraftMessageInput'),
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
          svc().draftMessage(orgOf(c as never).id, b.businessId, userOf(c as never), {
            kind: b.kind,
            language: b.language,
            context: b.context,
          }),
        )) as never,
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/batches',
      tags: ['ai'],
      summary: 'Many bills or statement lines at once, as a batch (half price, up to a day)',
      security,
      middleware: [requirePermission('purchases', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  businessId: z.string().uuid(),
                  kind: z.enum(['extract_bills', 'categorise_statement']),
                  items: z
                    .array(
                      z.object({
                        id: z.string().min(1).max(64),
                        text: z.string().max(60_000).optional(),
                        input: z.record(z.string(), z.unknown()).optional(),
                      }),
                    )
                    .min(1)
                    .max(100),
                })
                .openapi('AiBatchInput'),
            },
          },
        },
      },
      responses: { 202: json(any, 'Queued'), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        (await run(() =>
          svc().createBatch({ orgId: orgOf(c as never).id, by: userOf(c as never), ...b }),
        )) as never,
        202,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/batches',
      tags: ['ai'],
      summary: 'Batches of this business, newest first',
      security,
      middleware: [requirePermission('purchases', 'view')] as const,
      request: { params: orgParam, query: businessQuery },
      responses: { 200: json(z.array(any)), ...errors },
    }),
    async (c) =>
      c.json(
        (await run(() =>
          svc().batches(orgOf(c as never).id, c.req.valid('query').businessId),
        )) as never,
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/batches/{batchId}',
      tags: ['ai'],
      summary: 'One batch with its results once it has ended',
      security,
      middleware: [requirePermission('purchases', 'view')] as const,
      request: {
        params: orgParam.extend({
          batchId: z
            .string()
            .uuid()
            .openapi({ param: { name: 'batchId', in: 'path' } }),
        }),
      },
      responses: { 200: json(any), ...errors },
    }),
    async (c) => {
      const { batchId } = c.req.valid('param') as { batchId: string };
      const b = await run(() => svc().batch(orgOf(c as never).id, batchId));
      if (!b) throw new ApiError(404, 'not_found', 'That batch was not found.');
      return c.json(b as never, 200);
    },
  );

  app.route('/v1/orgs/:orgId', r as never);
}
