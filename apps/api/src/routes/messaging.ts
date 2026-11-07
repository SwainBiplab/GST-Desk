/**
 * Messaging routes (prompt 44): the plan and channels, settings, templates and their approval status, the
 * outbox of messages waiting for a person, the log with each message's timeline, consent, recurring invoices,
 * and the providers' webhooks. Everything under an organisation is permission-checked with the shared matrix.
 */
import { can } from '@gst/domain';
import {
  LANGUAGES,
  KINDS,
  FREQUENCIES,
  DEFAULT_BODIES,
  renderPreview,
  resolveVariables,
  templateProblems,
  type MessageKind,
} from '@gst/messaging';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { subApp, type App } from '../app';
import { ApiError, errorSchema, forbidden, notFound, unauthorized } from '../errors';
import type { MessagingService } from '../messaging/service';
import { requireOrg, requirePermission, type OrgVars } from '../middleware/session';

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
const rows = z.array(z.record(z.string(), z.unknown()));
const kind = z.enum(KINDS);
const channel = z.enum(['whatsapp', 'email']);

type Ctx = Context<{ Variables: OrgVars }>;
const orgOf = (c: Ctx) => c.get('org' as never) as OrgVars['org'];
const userOf = (c: Ctx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};

const settingsSchema = z
  .object({
    onIssue: z.record(z.string(), z.boolean()),
    onPayment: z.boolean(),
    reminders: z.boolean(),
    offsets: z.array(z.number().int().min(-30).max(120)).max(8),
    quietStart: z.string().regex(/^\d{2}:\d{2}$/),
    quietEnd: z.string().regex(/^\d{2}:\d{2}$/),
    autoSend: z.record(z.string(), z.boolean()),
    channel: z.enum(['whatsapp_first', 'email_first', 'whatsapp', 'email']),
    defaultLanguage: z.enum(LANGUAGES),
  })
  .openapi('DispatchSettings');

const REASONS: Record<string, string> = {
  plan: 'Messaging is part of the cloud plan.',
  limit: 'This month’s messages are used up.',
  no_channel:
    'The customer has no way to be reached: add a phone number with their consent, or an e-mail address.',
  no_document: 'The document is cancelled or gone.',
  duplicate: 'This message was already made.',
  no_receipt: 'This payment has no receipt voucher.',
  not_chased: 'Nothing is owed on this document.',
};

export function messagingRoutes(app: App, deps: RouteDeps): void {
  const svc = (): MessagingService => {
    if (!deps.messaging)
      throw new ApiError(503, 'no_messaging', 'Messaging is not available on this server.');
    return deps.messaging.service;
  };
  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/status',
      tags: ['messaging'],
      summary:
        'Whether messaging is on for the plan, what has been used this month, and the channels configured',
      security,
      request: { params: orgParam },
      responses: {
        200: json(
          z
            .object({
              plan: z.string(),
              enabled: z.boolean(),
              used: z.number(),
              limit: z.number(),
              channels: z.object({ whatsapp: z.boolean(), email: z.boolean() }),
            })
            .openapi('MessagingStatus'),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const e = await svc().entitlement(o.id);
      const p = deps.messaging!.providers;
      return c.json({ ...e, channels: { whatsapp: !!p.whatsapp, email: !!p.email } }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/settings/{businessId}',
      tags: ['messaging'],
      summary: 'When messages are made for a business',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: idParam('businessId') },
      responses: { 200: json(settingsSchema), ...errors },
    }),
    async (c) => {
      const { businessId } = c.req.valid('param') as { businessId: string };
      return c.json(await svc().settings(orgOf(c as never).id, businessId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/messaging/settings/{businessId}',
      tags: ['messaging'],
      summary: 'Change when messages are made (settings rights)',
      security,
      middleware: [requirePermission('settings', 'edit')] as const,
      request: {
        params: idParam('businessId'),
        body: { content: { 'application/json': { schema: settingsSchema } } },
      },
      responses: { 200: json(settingsSchema), ...errors },
    }),
    async (c) => {
      const { businessId } = c.req.valid('param') as { businessId: string };
      const body = c.req.valid('json');
      await svc().saveSettings(orgOf(c as never).id, businessId, body as never);
      return c.json(body, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/templates',
      tags: ['messaging'],
      summary: 'The organisation’s templates in six languages, with the status Meta holds',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam },
      responses: { 200: json(rows), ...errors },
    }),
    async (c) => c.json(await svc().templates(orgOf(c as never).id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/templates/preview',
      tags: ['messaging'],
      summary:
        'A template as the customer will read it, with sample values, and what is wrong with it',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                kind,
                language: z.enum(LANGUAGES),
                body: z.string().max(1100).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(z.object({ text: z.string(), problems: z.array(z.string()) })),
        ...errors,
      },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const body = b.body ?? DEFAULT_BODIES[b.kind][b.language];
      const sample = resolveVariables(b.kind, {
        party: 'Sharma Stores',
        number: 'INV/26-27/0042',
        amountPaise: 1_234_500,
        business: 'Your business',
        due: '2026-12-10',
      });
      return c.json(
        { text: renderPreview(body, sample), problems: templateProblems(body, b.kind) },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/messaging/templates/{templateId}',
      tags: ['messaging'],
      summary: 'Change the text of a template; it needs Meta’s approval again',
      security,
      middleware: [requirePermission('settings', 'edit')] as const,
      request: {
        params: idParam('templateId'),
        body: {
          content: {
            'application/json': { schema: z.object({ body: z.string().min(10).max(1024) }) },
          },
        },
      },
      responses: { 204: { description: 'Saved' }, ...errors },
    }),
    async (c) => {
      const { templateId } = c.req.valid('param') as { templateId: string };
      const { body } = c.req.valid('json');
      const o = orgOf(c as never);
      const list = await svc().templates(o.id);
      const t = list.find((x) => x['id'] === templateId);
      if (!t) throw notFound('That template');
      const problems = templateProblems(body, t['kind'] as MessageKind);
      if (problems.length) throw new ApiError(422, 'template_invalid', problems.join('; '));
      await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        await tx`UPDATE message_templates SET body = ${body}, status = 'draft', meta_id = NULL, reason = NULL, updated_at = ${Date.now()} WHERE id = ${templateId}`;
      });
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/templates/submit',
      tags: ['messaging'],
      summary: 'Send the draft templates (all, or one language) to Meta for review',
      security,
      middleware: [requirePermission('settings', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': { schema: z.object({ language: z.enum(LANGUAGES).optional() }) },
          },
        },
      },
      responses: {
        200: json(z.object({ submitted: z.number(), failed: z.array(z.string()) })),
        ...errors,
      },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const wa = deps.messaging!.providers.whatsappLive;
      if (!wa) throw new ApiError(503, 'no_whatsapp', 'WhatsApp is not configured on this server.');
      const { language } = c.req.valid('json');
      const list = (await svc().templates(o.id)).filter(
        (t) => t['status'] === 'draft' && (!language || t['language'] === language),
      );
      let submitted = 0;
      const failed: string[] = [];
      for (const t of list) {
        const k = t['kind'] as MessageKind;
        try {
          const examples = resolveVariables(k, {
            party: 'Sharma Stores',
            number: 'INV/26-27/0042',
            amountPaise: 1_234_500,
            business: 'Your business',
            due: '2026-12-10',
          });
          const res = await wa.submitTemplate({
            name: String(t['name']),
            language: String(t['language']),
            body: String(t['body']),
            examples,
            documentHeader: true,
          });
          await svc().setTemplateStatus(
            o.id,
            String(t['name']),
            String(t['language']),
            res.status,
            null,
            res.id,
          );
          submitted++;
        } catch (e) {
          failed.push(
            `${String(t['language'])} ${k}: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`,
          );
        }
      }
      return c.json({ submitted, failed }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/templates/sync',
      tags: ['messaging'],
      summary: 'Read the approval status of every template from Meta',
      security,
      middleware: [requirePermission('settings', 'edit')] as const,
      request: { params: orgParam },
      responses: { 200: json(z.object({ updated: z.number() })), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const wa = deps.messaging!.providers.whatsappLive;
      if (!wa) throw new ApiError(503, 'no_whatsapp', 'WhatsApp is not configured on this server.');
      const mine = await svc().templates(o.id);
      let updated = 0;
      for (const t of await wa.listTemplates()) {
        const m = mine.find((x) => x['name'] === t.name && x['language'] === t.language);
        if (!m) continue;
        await svc().setTemplateStatus(o.id, t.name, t.language, t.status, t.reason ?? null, t.id);
        updated++;
      }
      return c.json({ updated }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/outbox',
      tags: ['messaging'],
      summary: 'Messages waiting for a person to approve them',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam, query: z.object({ businessId: z.string().uuid().optional() }) },
      responses: { 200: json(rows), ...errors },
    }),
    async (c) =>
      c.json(await svc().outbox(orgOf(c as never).id, c.req.valid('query').businessId), 200),
  );

  const approver = async (c: Ctx) => {
    const p = orgOf(c).perms;
    if (!can(p, 'sales', 'issue') && !can(p, 'payments', 'create'))
      throw forbidden('Your role cannot approve messages.');
  };

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/messages/{messageId}/approve',
      tags: ['messaging'],
      summary: 'Approve a waiting message (optionally with its text changed): it is sent',
      security,
      request: {
        params: idParam('messageId'),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                body: z.string().min(1).max(1024).optional(),
                subject: z.string().max(200).optional(),
              }),
            },
          },
        },
      },
      responses: { 204: { description: 'Approved' }, ...errors },
    }),
    async (c) => {
      await approver(c as never);
      const { messageId } = c.req.valid('param') as { messageId: string };
      const ok = await svc().approve(
        orgOf(c as never).id,
        messageId,
        userOf(c as never),
        c.req.valid('json'),
      );
      if (!ok) throw new ApiError(409, 'not_waiting', 'That message is not waiting for approval.');
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/messages/{messageId}/reject',
      tags: ['messaging'],
      summary: 'Turn a waiting message down',
      security,
      request: { params: idParam('messageId') },
      responses: { 204: { description: 'Turned down' }, ...errors },
    }),
    async (c) => {
      await approver(c as never);
      const { messageId } = c.req.valid('param') as { messageId: string };
      if (!(await svc().reject(orgOf(c as never).id, messageId, userOf(c as never))))
        throw new ApiError(409, 'not_waiting', 'That message is not waiting for approval.');
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/messaging/send',
      tags: ['messaging'],
      summary:
        'Make a message for a document or payment now: it waits in the outbox (or goes, with auto-send on)',
      security,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                businessId: z.string().uuid(),
                kind,
                documentId: z.string().uuid(),
                paymentId: z.string().uuid().optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(z.object({ id: z.string(), approval: z.string(), channel: z.string() })),
        ...errors,
      },
    }),
    async (c) => {
      await approver(c as never);
      const b = c.req.valid('json');
      const res = await svc().prepare({
        orgId: orgOf(c as never).id,
        businessId: b.businessId,
        kind: b.kind,
        documentId: b.documentId,
        ...(b.paymentId ? { paymentId: b.paymentId } : {}),
        createdBy: userOf(c as never),
        again: true,
      });
      if (!res.ok)
        throw new ApiError(
          res.reason === 'plan' || res.reason === 'limit' ? 402 : 422,
          `message_${res.reason}`,
          `${REASONS[res.reason] ?? res.reason}${res.detail ? ` (${res.detail})` : ''}`,
        );
      return c.json({ id: res.id, approval: res.approval, channel: res.channel }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/log',
      tags: ['messaging'],
      summary: 'Messages of a party or a document, each with its status timeline',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: {
        params: orgParam,
        query: z.object({
          documentId: z.string().uuid().optional(),
          partyId: z.string().uuid().optional(),
        }),
      },
      responses: { 200: json(rows), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        await svc().log(orgOf(c as never).id, {
          ...(q.documentId ? { documentId: q.documentId } : {}),
          ...(q.partyId ? { partyId: q.partyId } : {}),
        }),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/messaging/consent',
      tags: ['messaging'],
      summary: 'Record that a customer agreed to, or asked to stop, messages on a channel',
      security,
      middleware: [requirePermission('parties', 'edit')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                partyId: z.string().uuid(),
                channel,
                status: z.enum(['opted_in', 'opted_out']),
              }),
            },
          },
        },
      },
      responses: { 204: { description: 'Recorded' }, ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      await svc().setConsent(
        orgOf(c as never).id,
        b.partyId,
        b.channel,
        b.status,
        `staff:${userOf(c as never)}`,
      );
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/messaging/consent/{partyId}',
      tags: ['messaging'],
      summary: 'Where a customer stands on each channel',
      security,
      middleware: [requirePermission('parties', 'view')] as const,
      request: { params: idParam('partyId') },
      responses: { 200: json(z.record(z.string(), z.string())), ...errors },
    }),
    async (c) =>
      c.json(
        (await svc().consentOf(
          orgOf(c as never).id,
          (c.req.valid('param') as { partyId: string }).partyId,
        )) as Record<string, string>,
        200,
      ),
  );

  const recurringBody = z.object({
    businessId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    sourceDocumentId: z.string().uuid(),
    frequency: z.enum(FREQUENCIES),
    every: z.number().int().min(1).max(12).default(1),
    dayOfMonth: z.number().int().min(1).max(31).default(1),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    dueDays: z.number().int().min(0).max(120).default(0),
    send: z.boolean().default(false),
  });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/recurring-invoices',
      tags: ['recurring'],
      summary: 'Recurring invoices and when each runs next',
      security,
      middleware: [requirePermission('sales', 'view')] as const,
      request: { params: orgParam },
      responses: { 200: json(rows), ...errors },
    }),
    async (c) => c.json(await svc().recurringList(orgOf(c as never).id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/recurring-invoices',
      tags: ['recurring'],
      summary: 'Make an issued invoice recur: the server issues a copy on each date',
      security,
      middleware: [requirePermission('sales', 'issue')] as const,
      request: {
        params: orgParam,
        body: { content: { 'application/json': { schema: recurringBody } } },
      },
      responses: { 201: json(z.object({ id: z.string() })), ...errors },
    }),
    async (c) => {
      const o = orgOf(c as never);
      const ent = await svc().entitlement(o.id);
      if (ent.plan === 'free')
        throw new ApiError(402, 'plan', 'Recurring invoices are part of the cloud plan.');
      const b = c.req.valid('json');
      const id = await svc().recurringCreate(o.id, { ...b, endDate: b.endDate ?? null });
      return c.json({ id }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/recurring-invoices/{recurringId}',
      tags: ['recurring'],
      summary: 'Pause, resume, or change whether the invoices are sent',
      security,
      middleware: [requirePermission('sales', 'issue')] as const,
      request: {
        params: idParam('recurringId'),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                active: z.boolean().optional(),
                send: z.boolean().optional(),
                endDate: z.string().nullable().optional(),
              }),
            },
          },
        },
      },
      responses: { 204: { description: 'Changed' }, ...errors },
    }),
    async (c) => {
      const { recurringId } = c.req.valid('param') as { recurringId: string };
      const b = c.req.valid('json');
      const o = orgOf(c as never);
      const done = await deps.db.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        return tx`UPDATE recurring_invoices SET active = coalesce(${b.active ?? null}, active), send = coalesce(${b.send ?? null}, send),
          end_date = CASE WHEN ${'endDate' in b} THEN ${b.endDate ?? null} ELSE end_date END, updated_at = ${Date.now()} WHERE id = ${recurringId} RETURNING id`;
      });
      if (!done.length) throw notFound('That recurring invoice');
      return c.body(null, 204);
    },
  );

  app.route('/v1/orgs/:orgId', r as never);
}
