/**
 * Dispatch (prompt 44): invoices, receipts and payment reminders sent from the cloud tier. A message is
 * made (`prepare`), shown for approval unless the business turned auto-send on for that kind, delivered by a
 * queue job (`deliver`) with retries, and followed by the provider's webhooks (`applyEvents`). Every table
 * is read under the organisation's row-level security; nothing here logs an address, a name or a body.
 */
import {
  BaseRepo,
  BusinessRepo,
  DocumentFlowRepo,
  PartyRepo,
  PaymentFlowRepo,
  ReviewRepo,
  newId,
  type Ctx,
  type Row,
} from '@gst/db';
import { draftFromRows, draftToRows, isProvisional } from '@gst/domain';
import {
  DEFAULT_BODIES,
  DEFAULT_OFFSETS,
  DEFAULT_QUIET,
  KINDS,
  LANGUAGES,
  MessagingError,
  advances,
  afterQuiet,
  dueDates,
  dueReminders,
  firstRun,
  istDate,
  istInstant,
  isLanguage,
  nextRun,
  renderPreview,
  renderSubject,
  resolveVariables,
  templateName,
  addDays,
  type Channel,
  type DeliveryStatus,
  type Language,
  type MessageKind,
  type MessagingAdapter,
  type WebhookEvents,
} from '@gst/messaging';
import type { Logger } from 'pino';

import type { PgDatabase } from '../db/pool';

import { renderDocumentPdf } from './pdf';

export interface Providers {
  whatsapp: MessagingAdapter | null;
  email: MessagingAdapter | null;
}

export type DispatchJob = { type: 'deliver'; orgId: string; messageId: string };

export interface ServiceOptions {
  db: PgDatabase;
  providers: Providers;
  log: Logger;
  now?: () => number;
  /** Put a delivery on the queue (optionally later). Without one, deliveries wait for `deliver` to be called. */
  enqueue?: (job: DispatchJob, delayMs?: number) => Promise<void>;
}

export const MAX_ATTEMPTS = 5;

export interface Settings {
  onIssue: Record<string, boolean>;
  onPayment: boolean;
  reminders: boolean;
  offsets: number[];
  quietStart: string;
  quietEnd: string;
  autoSend: Record<string, boolean>;
  channel: 'whatsapp_first' | 'email_first' | 'whatsapp' | 'email';
  defaultLanguage: Language;
}

export const DEFAULT_SETTINGS: Settings = {
  onIssue: {},
  onPayment: false,
  reminders: false,
  offsets: [...DEFAULT_OFFSETS],
  quietStart: DEFAULT_QUIET.start,
  quietEnd: DEFAULT_QUIET.end,
  autoSend: {},
  channel: 'whatsapp_first',
  defaultLanguage: 'en',
};

export interface Entitlement {
  plan: string;
  enabled: boolean;
  used: number;
  limit: number;
}

export type Prepared =
  | { ok: true; id: string; approval: 'pending' | 'auto'; channel: Channel }
  | {
      ok: false;
      reason:
        'plan' | 'limit' | 'no_channel' | 'no_document' | 'duplicate' | 'no_receipt' | 'not_chased';
      detail?: string;
    };

const digits = (s: string): string => s.replace(/\D/g, '');
/** A number as WhatsApp wants it: country code first; a ten-digit Indian number gets 91. */
export const whatsappNumber = (s: string | null | undefined): string | null => {
  const d = digits(s ?? '');
  if (d.length === 10) return `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
};

const monthStart = (ms: number): number => {
  const d = istDate(ms);
  return istInstant(`${d.slice(0, 7)}-01`, '00:00');
};

export class MessagingService {
  private readonly now: () => number;

  constructor(private readonly o: ServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  /* --------------------------------------------------------------------------------- plumbing */

  private org(orgId: string, fn: (tx: any) => Promise<any>): Promise<any> {
    return this.o.db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return fn(tx);
    });
  }

  private ctx(orgId: string, businessId: string): Ctx {
    return { orgId, businessId, actor: 'system:messaging', deviceId: 'api' };
  }

  /* --------------------------------------------------------------------------------- plan */

  async entitlement(orgId: string): Promise<Entitlement> {
    return this.org(orgId, async (tx) => {
      const [p] =
        await tx`SELECT s.plan_id, s.status, pl.limits_json FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.org_id = ${orgId}`;
      const limit = Number(
        (p?.['limits_json'] as { messages?: number } | undefined)?.messages ?? 0,
      );
      const active = p && ['active', 'trial'].includes(String(p['status']));
      const [u] =
        await tx`SELECT coalesce(sum(quantity), 0)::bigint AS n FROM usage_events WHERE org_id = ${orgId} AND kind = 'message' AND at >= ${monthStart(this.now())}`;
      return {
        plan: String(p?.['plan_id'] ?? 'free'),
        enabled: !!active && limit > 0,
        used: Number(u?.['n'] ?? 0),
        limit,
      };
    });
  }

  /* --------------------------------------------------------------------------------- settings */

  async settings(orgId: string, businessId: string): Promise<Settings> {
    const [r] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM dispatch_settings WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    if (!r) return { ...DEFAULT_SETTINGS };
    return {
      onIssue: (r['on_issue'] ?? {}) as Record<string, boolean>,
      onPayment: r['on_payment'] === true,
      reminders: r['reminders'] === true,
      offsets: ((r['offsets'] ?? DEFAULT_OFFSETS) as number[]).map(Number),
      quietStart: String(r['quiet_start']),
      quietEnd: String(r['quiet_end']),
      autoSend: (r['auto_send'] ?? {}) as Record<string, boolean>,
      channel: r['channel'] as Settings['channel'],
      defaultLanguage: isLanguage(r['default_language']) ? r['default_language'] : 'en',
    };
  }

  async saveSettings(orgId: string, businessId: string, s: Settings): Promise<void> {
    await this.org(
      orgId,
      (
        tx,
      ) => tx`INSERT INTO dispatch_settings (org_id, business_id, on_issue, on_payment, reminders, offsets, quiet_start, quiet_end, auto_send, channel, default_language, updated_at)
        VALUES (${orgId}, ${businessId}, ${JSON.stringify(s.onIssue)}::jsonb, ${s.onPayment}, ${s.reminders}, ${JSON.stringify(s.offsets)}::jsonb, ${s.quietStart}, ${s.quietEnd}, ${JSON.stringify(s.autoSend)}::jsonb, ${s.channel}, ${s.defaultLanguage}, ${this.now()})
        ON CONFLICT (org_id, business_id) DO UPDATE SET on_issue = EXCLUDED.on_issue, on_payment = EXCLUDED.on_payment, reminders = EXCLUDED.reminders, offsets = EXCLUDED.offsets,
          quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, auto_send = EXCLUDED.auto_send, channel = EXCLUDED.channel, default_language = EXCLUDED.default_language, updated_at = EXCLUDED.updated_at`,
    );
  }

  /* --------------------------------------------------------------------------------- templates */

  /** The 3 messages in 6 languages, as drafts, where the organisation has none yet. */
  async ensureTemplates(orgId: string): Promise<void> {
    const now = this.now();
    await this.org(orgId, async (tx) => {
      for (const kind of KINDS)
        for (const lang of LANGUAGES)
          await tx`INSERT INTO message_templates (id, org_id, kind, language, name, body, status, created_at, updated_at)
            VALUES (${newId()}, ${orgId}, ${kind}, ${lang}, ${templateName(orgId, kind)}, ${DEFAULT_BODIES[kind][lang]}, 'draft', ${now}, ${now})
            ON CONFLICT (org_id, kind, language) DO NOTHING`;
    });
  }

  async templates(orgId: string): Promise<Row[]> {
    await this.ensureTemplates(orgId);
    return this.org(
      orgId,
      (tx) =>
        tx`SELECT id, kind, language, name, body, status, meta_id, reason, updated_at FROM message_templates ORDER BY kind, language`,
    );
  }

  /** Mirror what Meta holds (a listing, or a webhook) into the organisation's templates. */
  async setTemplateStatus(
    orgId: string,
    name: string,
    language: string,
    status: string,
    reason: string | null,
    metaId?: string,
  ): Promise<void> {
    await this.org(
      orgId,
      (
        tx,
      ) => tx`UPDATE message_templates SET status = ${status}, reason = ${reason}, meta_id = coalesce(${metaId ?? null}, meta_id), updated_at = ${this.now()}
        WHERE org_id = ${orgId} AND name = ${name} AND language = ${language}`,
    );
  }

  /* --------------------------------------------------------------------------------- consent */

  async setConsent(
    orgId: string,
    partyId: string,
    channel: Channel,
    status: 'opted_in' | 'opted_out',
    source: string,
  ): Promise<void> {
    await this.org(
      orgId,
      (
        tx,
      ) => tx`INSERT INTO party_consent (org_id, party_id, channel, status, source, at) VALUES (${orgId}, ${partyId}, ${channel}, ${status}, ${source}, ${this.now()})
        ON CONFLICT (org_id, party_id, channel) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, at = EXCLUDED.at`,
    );
  }

  async consentOf(
    orgId: string,
    partyId: string,
  ): Promise<Partial<Record<Channel, 'opted_in' | 'opted_out'>>> {
    const rows = await this.org(
      orgId,
      (tx) =>
        tx`SELECT channel, status FROM party_consent WHERE org_id = ${orgId} AND party_id = ${partyId}`,
    );
    return Object.fromEntries(rows.map((r: Row) => [r['channel'], r['status']]));
  }

  /* --------------------------------------------------------------------------------- prepare */

  async prepare(a: {
    orgId: string;
    businessId: string;
    kind: MessageKind;
    documentId: string;
    paymentId?: string;
    reminderOffset?: number;
    createdBy: string;
    /** A deliberate resend: not stopped by an earlier message for the same document. */
    again?: boolean;
  }): Promise<Prepared> {
    const ent = await this.entitlement(a.orgId);
    if (!ent.enabled) return { ok: false, reason: 'plan' };
    if (ent.used >= ent.limit) return { ok: false, reason: 'limit' };
    const ctx = this.ctx(a.orgId, a.businessId);
    const settings = await this.settings(a.orgId, a.businessId);
    await this.ensureTemplates(a.orgId);

    const flow = new DocumentFlowRepo(this.o.db);
    // a receipt carries the receipt voucher; an invoice or a reminder carries the invoice
    let attachId = a.documentId;
    let payment: Row | null = null;
    if (a.kind === 'receipt') {
      if (!a.paymentId) return { ok: false, reason: 'no_receipt' };
      payment = await new BaseRepo(this.o.db, 'payments').get(ctx, a.paymentId);
      if (!payment?.['voucher_id']) return { ok: false, reason: 'no_receipt' };
      attachId = String(payment['voucher_id']);
    }
    const found = await flow.load(ctx, attachId);
    if (!found || found.document['status'] === 'cancelled' || found.document['deleted_at'] != null)
      return { ok: false, reason: 'no_document' };
    const doc = found.document;
    if (
      a.kind === 'reminder' &&
      (doc['status'] !== 'issued' ||
        !['tax_invoice', 'bill_of_supply', 'debit_note'].includes(String(doc['type'])))
    )
      return { ok: false, reason: 'not_chased' };
    const party = doc['party_id'] ? await new PartyRepo(this.o.db).get(ctx, doc['party_id']) : null;
    if (!party) return { ok: false, reason: 'no_channel', detail: 'no customer on the document' };

    const consent = await this.consentOf(a.orgId, String(party['id']));
    const lang: Language = isLanguage(party['language'])
      ? party['language']
      : settings.defaultLanguage;
    const tpl = await this.org(
      a.orgId,
      (tx) =>
        tx`SELECT kind, language, name, body, status FROM message_templates WHERE kind = ${a.kind}`,
    );
    const find = (l: Language, approvedOnly: boolean) =>
      tpl.find((t: Row) => t['language'] === l && (!approvedOnly || t['status'] === 'approved'));

    const wa = whatsappNumber(party['phone']);
    const mail =
      typeof party['email'] === 'string' && party['email'].includes('@')
        ? String(party['email']).trim()
        : null;
    const reminderBlocked = a.kind === 'reminder' && Object.values(consent).includes('opted_out');
    if (reminderBlocked) return { ok: false, reason: 'no_channel', detail: 'opted out' };

    type Choice = { channel: Channel; to: string; language: Language; name: string; body: string };
    const choices: Choice[] = [];
    if (this.o.providers.whatsapp && wa && consent.whatsapp === 'opted_in') {
      const t = find(lang, true) ?? find('en', true);
      if (t)
        choices.push({
          channel: 'whatsapp',
          to: wa,
          language: t['language'] as Language,
          name: String(t['name']),
          body: String(t['body']),
        });
    }
    if (this.o.providers.email && mail && consent.email !== 'opted_out') {
      const t = find(lang, false) ?? find('en', false);
      choices.push({
        channel: 'email',
        to: mail,
        language: (t?.['language'] as Language | undefined) ?? lang,
        name: String(t?.['name'] ?? templateName(a.orgId, a.kind)),
        body: String(t?.['body'] ?? DEFAULT_BODIES[a.kind][lang]),
      });
    }
    const order =
      settings.channel === 'email'
        ? ['email']
        : settings.channel === 'whatsapp'
          ? ['whatsapp']
          : settings.channel === 'email_first'
            ? ['email', 'whatsapp']
            : ['whatsapp', 'email'];
    const pick = order.map((c) => choices.find((x) => x.channel === c)).find(Boolean);
    if (!pick)
      return {
        ok: false,
        reason: 'no_channel',
        detail: wa && consent.whatsapp !== 'opted_in' ? 'no WhatsApp consent' : 'no address',
      };

    const business = (await new BusinessRepo(this.o.db).get(ctx)) ?? {};
    const businessName = String(business['trade_name'] ?? business['legal_name'] ?? '');
    let amount = BigInt(String(doc['total_paise'] ?? 0));
    let number = String(doc['number'] ?? '');
    if (a.kind === 'receipt' && payment) {
      amount = BigInt(String(payment['amount_paise']));
      const allocs = await new PaymentFlowRepo(this.o.db).allocationsFor(
        ctx,
        String(payment['id']),
      );
      const nums: string[] = [];
      for (const al of allocs) {
        const d = await flow.load(ctx, String(al['document_id']));
        if (d?.document['number']) nums.push(String(d.document['number']));
      }
      number = nums.length ? nums.join(', ') : number;
    }
    if (a.kind === 'reminder') {
      const pos = await new PaymentFlowRepo(this.o.db).positions(
        ctx,
        istDate(this.now()),
        String(party['id']),
      );
      const p = pos.documents.find((x) => x.id === a.documentId);
      if (!p || p.balancePaise <= 0n) return { ok: false, reason: 'not_chased' };
      amount = p.balancePaise;
    }
    const variables = resolveVariables(a.kind, {
      party: String(party['name']),
      number,
      amountPaise: amount,
      business: businessName,
      due: (doc['due_date'] as string | null) ?? null,
    });
    const key =
      a.kind === 'receipt'
        ? `receipt:${a.paymentId}`
        : a.kind === 'reminder'
          ? `reminder:${a.documentId}:${a.reminderOffset ?? 0}`
          : `invoice:${a.documentId}`;
    const auto = settings.autoSend[a.kind] === true;
    const now = this.now();
    const notBefore =
      a.kind === 'reminder'
        ? afterQuiet(now, { start: settings.quietStart, end: settings.quietEnd })
        : null;
    const id = newId();
    const inserted = await this.org(a.orgId, async (tx) => {
      const r =
        await tx`INSERT INTO message_log (id, org_id, business_id, party_id, document_id, payment_id, kind, channel, to_address, language, template_name, variables, subject, body, approval, status, dedupe_key, not_before, created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${String(party['id'])}, ${attachId}, ${a.paymentId ?? null}, ${a.kind}, ${pick.channel}, ${pick.to}, ${pick.language}, ${pick.name}, ${JSON.stringify(variables)}::jsonb,
          ${pick.channel === 'email' ? renderSubject(a.kind, pick.language, { number, business: businessName }) : null}, ${renderPreview(pick.body, variables)}, ${auto ? 'auto' : 'pending'}, 'queued',
          ${a.again ? `${key}:${now}` : key}, ${notBefore}, ${a.createdBy}, ${now}, ${now})
        ON CONFLICT (org_id, dedupe_key) DO NOTHING RETURNING id`;
      if (r.length)
        await tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${a.orgId}, ${id}, 'queued', ${auto ? 'auto-send' : 'waiting for approval'}, ${now})`;
      return r.length > 0;
    });
    if (!inserted) return { ok: false, reason: 'duplicate' };
    this.o.log.info(
      {
        org: a.orgId,
        message: id,
        kind: a.kind,
        channel: pick.channel,
        approval: auto ? 'auto' : 'pending',
      },
      'message prepared',
    );
    if (auto)
      await this.o.enqueue?.(
        { type: 'deliver', orgId: a.orgId, messageId: id },
        notBefore ? Math.max(0, notBefore - now) : 0,
      );
    return { ok: true, id, approval: auto ? 'auto' : 'pending', channel: pick.channel };
  }

  /* --------------------------------------------------------------------------------- approval */

  async outbox(orgId: string, businessId?: string): Promise<Row[]> {
    return this.org(
      orgId,
      (
        tx,
      ) => tx`SELECT id, business_id, party_id, document_id, kind, channel, to_address, language, subject, body, variables, created_at FROM message_log
      WHERE approval = 'pending' AND status = 'queued' ${businessId ? tx`AND business_id = ${businessId}` : tx``} ORDER BY created_at DESC LIMIT 200`,
    );
  }

  /** Approve a waiting message, optionally with the body edited, and put it on the queue. */
  async approve(
    orgId: string,
    id: string,
    by: string,
    edit?: { body?: string | undefined; subject?: string | undefined },
  ): Promise<boolean> {
    const now = this.now();
    const rows = await this.org(
      orgId,
      (
        tx,
      ) => tx`UPDATE message_log SET approval = 'approved', decided_by = ${by}, decided_at = ${now}, updated_at = ${now},
        body = coalesce(${edit?.body ?? null}, body), subject = coalesce(${edit?.subject ?? null}, subject)
        WHERE id = ${id} AND approval = 'pending' AND status = 'queued' RETURNING id, not_before`,
    );
    if (!rows.length) return false;
    await this.event(orgId, id, 'queued', `approved`);
    const nb = Number(rows[0]!['not_before'] ?? 0);
    await this.o.enqueue?.({ type: 'deliver', orgId, messageId: id }, nb > now ? nb - now : 0);
    return true;
  }

  async reject(orgId: string, id: string, by: string): Promise<boolean> {
    const now = this.now();
    const rows = await this.org(
      orgId,
      (
        tx,
      ) => tx`UPDATE message_log SET approval = 'rejected', decided_by = ${by}, decided_at = ${now}, updated_at = ${now}, status = 'failed', error = 'turned down'
        WHERE id = ${id} AND approval = 'pending' AND status = 'queued' RETURNING id`,
    );
    if (rows.length) await this.event(orgId, id, 'failed', 'turned down');
    return rows.length > 0;
  }

  private event(
    orgId: string,
    messageId: string,
    status: string,
    detail: string | null,
    at = this.now(),
  ): Promise<unknown> {
    return this.org(
      orgId,
      (tx) =>
        tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${orgId}, ${messageId}, ${status}, ${detail}, ${at})`,
    );
  }

  /* --------------------------------------------------------------------------------- deliver */

  /**
   * Send one approved message. Safe to run twice (the row is locked, and a message with a provider id is not
   * sent again). A busy provider throws, so the queue retries with backoff; a refusal ends the message.
   */
  async deliver(
    orgId: string,
    messageId: string,
  ): Promise<'sent' | 'skipped' | 'failed' | 'later'> {
    const r = await this.deliverOnce(orgId, messageId);
    // thrown after the transaction committed, so the attempt count and its note are kept
    if (typeof r === 'object') throw r.retry;
    return r;
  }

  private async deliverOnce(
    orgId: string,
    messageId: string,
  ): Promise<'sent' | 'skipped' | 'failed' | 'later' | { retry: MessagingError }> {
    const now = this.now();
    return this.org(orgId, async (tx) => {
      const [m] =
        await tx`SELECT * FROM message_log WHERE id = ${messageId} FOR UPDATE SKIP LOCKED`;
      if (
        !m ||
        m['provider_id'] ||
        m['status'] !== 'queued' ||
        !['approved', 'auto'].includes(String(m['approval']))
      )
        return 'skipped' as const;
      if (m['not_before'] && Number(m['not_before']) > now) return 'later' as const;
      const fail = async (why: string) => {
        await tx`UPDATE message_log SET status = 'failed', error = ${why}, updated_at = ${now} WHERE id = ${messageId}`;
        await tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${orgId}, ${messageId}, 'failed', ${why}, ${now})`;
        this.o.log.warn({ org: orgId, message: messageId, why }, 'message not sent');
        return 'failed' as const;
      };
      const channel = m['channel'] as Channel;
      const adapter = this.o.providers[channel === 'whatsapp' ? 'whatsapp' : 'email'];
      if (!adapter) return fail('the channel is not configured');
      // things can change between asking and sending: the customer opts out, the invoice is cancelled, the plan runs out
      const [c] =
        await tx`SELECT status FROM party_consent WHERE party_id = ${m['party_id']} AND channel = ${channel}`;
      const [optedOutAny] =
        m['kind'] === 'reminder'
          ? await tx`SELECT 1 FROM party_consent WHERE party_id = ${m['party_id']} AND status = 'opted_out'`
          : [undefined];
      if (c?.['status'] === 'opted_out' || optedOutAny) return fail('the customer opted out');
      if (channel === 'whatsapp' && c?.['status'] !== 'opted_in')
        return fail('no WhatsApp consent');
      const ent = await this.entitlement(orgId);
      if (!ent.enabled || ent.used >= ent.limit) return fail('plan limit reached');
      const ctx = this.ctx(orgId, String(m['business_id']));
      const rendered = await renderDocumentPdf(this.o.db, ctx, String(m['document_id']));
      if (!rendered || rendered.document['status'] === 'cancelled')
        return fail('the document is cancelled or gone');
      if (m['kind'] === 'reminder') {
        const pos = await new PaymentFlowRepo(this.o.db).positions(
          ctx,
          istDate(now),
          String(m['party_id']),
        );
        const p = pos.documents.find((x) => x.id === String(m['document_id']));
        if (!p || p.balancePaise <= 0n) return fail('already paid');
      }
      const document = {
        fileName: rendered.fileName,
        mime: 'application/pdf',
        bytes: rendered.bytes,
      };
      try {
        const res = await adapter.sendTemplate({
          to: String(m['to_address']),
          template: String(m['template_name']),
          language: String(m['language']),
          variables: m['variables'] as string[],
          document,
          idempotencyKey: String(m['id']),
          ...(m['subject'] ? { subject: String(m['subject']) } : {}),
          ...(channel === 'email' ? { text: String(m['body']) } : {}),
        });
        await tx`UPDATE message_log SET provider_id = ${res.providerId}, status = ${res.status}, sent_at = ${now}, updated_at = ${now}, attempts = attempts + 1, error = NULL WHERE id = ${messageId}`;
        await tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${orgId}, ${messageId}, ${res.status}, 'handed to the provider', ${now})`;
        await tx`INSERT INTO usage_events (id, org_id, business_id, kind, quantity, ref, at, created_at) VALUES (${newId()}, ${orgId}, ${m['business_id']}, 'message', 1, ${messageId}, ${now}, ${now})`;
        this.o.log.info({ org: orgId, message: messageId, channel }, 'message sent');
        return 'sent' as const;
      } catch (e) {
        if (!(e instanceof MessagingError)) throw e;
        const attempts = Number(m['attempts']) + 1;
        if (!e.retryable || attempts >= MAX_ATTEMPTS) {
          await tx`UPDATE message_log SET attempts = ${attempts} WHERE id = ${messageId}`;
          return fail(e.message);
        }
        await tx`UPDATE message_log SET attempts = ${attempts}, error = ${e.message}, updated_at = ${now} WHERE id = ${messageId}`;
        await tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${orgId}, ${messageId}, 'queued', ${`retry ${attempts}: ${e.message}`}, ${now})`;
        // the transaction commits the attempt count; the queue then runs the job again after its backoff
        return { retry: e };
      }
    });
  }

  /* --------------------------------------------------------------------------------- webhooks */

  /** Apply a provider's events: each once, in any order, never moving a message backwards. */
  async applyEvents(
    provider: 'whatsapp' | 'resend',
    ev: WebhookEvents,
  ): Promise<{ applied: number; ignored: number }> {
    let applied = 0;
    let ignored = 0;
    const seen = async (key: string): Promise<boolean> => {
      const r = await this.o.db
        .sql`INSERT INTO webhook_events (event_key, provider, at) VALUES (${key}, ${provider}, ${this.now()}) ON CONFLICT DO NOTHING RETURNING event_key`;
      return r.length === 0;
    };
    for (const s of ev.statuses) {
      if (await seen(s.eventId)) {
        ignored++;
        continue;
      }
      const [link] = await this.o.db
        .sql`SELECT org_id FROM message_provider_ids WHERE provider_id = ${s.providerId} LIMIT 1`;
      if (!link) {
        ignored++;
        continue;
      }
      const orgId = String(link['org_id']);
      const moved = await this.org(orgId, async (tx) => {
        const [m] =
          await tx`SELECT id, status FROM message_log WHERE provider_id = ${s.providerId} FOR UPDATE`;
        if (!m) return false;
        await tx`INSERT INTO message_events (id, org_id, message_id, status, detail, at) VALUES (${newId()}, ${orgId}, ${m['id']}, ${s.status}, ${s.error ?? null}, ${s.at})`;
        if (!advances(m['status'] as DeliveryStatus, s.status)) return false;
        await tx`UPDATE message_log SET status = ${s.status}, error = ${s.error ?? null}, updated_at = ${this.now()} WHERE id = ${m['id']}`;
        return true;
      });
      if (moved) applied++;
      else ignored++;
    }
    for (const c of ev.consents) {
      if (await seen(c.eventId)) {
        ignored++;
        continue;
      }
      const rows = await this.o.db
        .sql`SELECT DISTINCT org_id, party_id FROM message_provider_ids WHERE channel = 'whatsapp' AND to_address = ${c.from} AND party_id IS NOT NULL`;
      for (const r of rows)
        await this.setConsent(
          String(r['org_id']),
          String(r['party_id']),
          'whatsapp',
          c.status,
          'whatsapp reply',
        );
      applied++;
    }
    for (const t of ev.templates) {
      if (await seen(t.eventId)) {
        ignored++;
        continue;
      }
      const rows = await this.o.db
        .sql`SELECT org_id FROM message_template_names WHERE name = ${t.name} AND language = ${t.language}`;
      for (const r of rows)
        await this.setTemplateStatus(
          String(r['org_id']),
          t.name,
          t.language,
          t.status,
          t.reason ?? null,
        );
      applied++;
    }
    return { applied, ignored };
  }

  /* --------------------------------------------------------------------------------- log */

  async log(
    orgId: string,
    q: { documentId?: string; partyId?: string; limit?: number },
  ): Promise<Row[]> {
    const rows = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM message_log WHERE true
      ${q.documentId ? tx`AND document_id = ${q.documentId}` : tx``} ${q.partyId ? tx`AND party_id = ${q.partyId}` : tx``} ORDER BY created_at DESC LIMIT ${q.limit ?? 100}`,
    );
    const ids = rows.map((r: Row) => String(r['id']));
    const events = ids.length
      ? await this.org(
          orgId,
          (tx) =>
            tx`SELECT message_id, status, detail, at FROM message_events WHERE message_id = ANY(${ids}) ORDER BY at, seq`,
        )
      : [];
    return rows.map((r: Row) => ({
      ...r,
      timeline: events
        .filter((e: Row) => e['message_id'] === r['id'])
        .map((e: Row) => ({ status: e['status'], detail: e['detail'], at: Number(e['at']) })),
    }));
  }

  /* --------------------------------------------------------------------------------- triggers */

  /** Called when a sync upload turned documents into issued ones or recorded payments. */
  async onApplied(
    orgId: string,
    by: string,
    ev: {
      issued: { id: string; businessId: string }[];
      payments: { id: string; businessId: string; documentId?: string | null }[];
    },
  ): Promise<void> {
    for (const d of ev.issued) {
      const s = await this.settings(orgId, d.businessId);
      const ctx = this.ctx(orgId, d.businessId);
      const doc = await new DocumentFlowRepo(this.o.db).load(ctx, d.id);
      if (!doc || !s.onIssue[String(doc.document['type'])]) continue;
      await this.prepare({
        orgId,
        businessId: d.businessId,
        kind: 'invoice',
        documentId: d.id,
        createdBy: by,
      });
    }
    for (const p of ev.payments) {
      const s = await this.settings(orgId, p.businessId);
      if (!s.onPayment) continue;
      await this.prepare({
        orgId,
        businessId: p.businessId,
        kind: 'receipt',
        documentId: p.documentId ?? p.id,
        paymentId: p.id,
        createdBy: by,
      });
    }
  }

  /* --------------------------------------------------------------------------------- reminders */

  /** One pass of the reminder rules over every business that turned them on. */
  async runReminders(orgId?: string): Promise<{ made: number; skipped: number }> {
    const orgs = orgId
      ? [{ org_id: orgId }]
      : await this.o.db
          .sql`SELECT DISTINCT org_id FROM message_provider_ids UNION SELECT org_id FROM dispatch_settings WHERE reminders`;
    let made = 0;
    let skipped = 0;
    for (const { org_id } of orgs) {
      const oid = String(org_id);
      const businesses = await this.org(
        oid,
        (tx) => tx`SELECT business_id FROM dispatch_settings WHERE reminders = true`,
      );
      for (const b of businesses) {
        const businessId = String(b['business_id']);
        const s = await this.settings(oid, businessId);
        const ctx = this.ctx(oid, businessId);
        const now = this.now();
        const pos = await new PaymentFlowRepo(this.o.db).positions(ctx, istDate(now));
        const partyIds = [
          ...new Set(pos.documents.map((d) => d.partyId).filter((x): x is string => !!x)),
        ];
        const parties = new Map<string, { id: string; optedOut: boolean; reachable: boolean }>();
        for (const id of partyIds) {
          const party = await new PartyRepo(this.o.db).get(ctx, id);
          const consent = await this.consentOf(oid, id);
          const wa =
            this.o.providers.whatsapp &&
            whatsappNumber(party?.['phone']) &&
            consent.whatsapp === 'opted_in';
          const mail =
            this.o.providers.email &&
            typeof party?.['email'] === 'string' &&
            String(party['email']).includes('@') &&
            consent.email !== 'opted_out';
          parties.set(id, {
            id,
            optedOut: Object.values(consent).includes('opted_out'),
            reachable: !!(wa || mail),
          });
        }
        const keys = await this.org(
          oid,
          (tx) =>
            tx`SELECT dedupe_key FROM message_log WHERE kind = 'reminder' AND business_id = ${businessId}`,
        );
        const made0 = new Set<string>(
          keys.map((k: Row) => String(k['dedupe_key']).replace(/^reminder:/, '')),
        );
        const { due } = dueReminders({
          now,
          documents: pos.documents.map((d) => ({
            id: d.id,
            partyId: d.partyId,
            type: d.type,
            status: 'issued',
            number: d.number,
            dueDate: d.dueDate,
            outstandingPaise: d.balancePaise,
          })),
          parties,
          offsets: s.offsets,
          made: made0,
          quiet: { start: s.quietStart, end: s.quietEnd },
        });
        for (const d of due) {
          const r = await this.prepare({
            orgId: oid,
            businessId,
            kind: 'reminder',
            documentId: d.documentId,
            reminderOffset: d.offset,
            createdBy: 'system:reminders',
          });
          if (r.ok) made++;
          else skipped++;
        }
      }
    }
    return { made, skipped };
  }

  /* --------------------------------------------------------------------------------- recurring */

  async recurringList(orgId: string): Promise<Row[]> {
    return this.org(orgId, (tx) => tx`SELECT * FROM recurring_invoices ORDER BY created_at DESC`);
  }

  async recurringCreate(
    orgId: string,
    a: {
      businessId: string;
      name: string;
      sourceDocumentId: string;
      frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
      every: number;
      dayOfMonth: number;
      start: string;
      endDate?: string | null;
      dueDays: number;
      send: boolean;
    },
  ): Promise<string> {
    const id = newId();
    const next = firstRun(a.start, {
      frequency: a.frequency,
      every: a.every,
      dayOfMonth: a.dayOfMonth,
    });
    const now = this.now();
    await this.org(
      orgId,
      (
        tx,
      ) => tx`INSERT INTO recurring_invoices (id, org_id, business_id, name, source_document_id, frequency, every, day_of_month, next_run, end_date, due_days, send, created_at, updated_at)
        VALUES (${id}, ${orgId}, ${a.businessId}, ${a.name}, ${a.sourceDocumentId}, ${a.frequency}, ${a.every}, ${a.dayOfMonth}, ${next}, ${a.endDate ?? null}, ${a.dueDays}, ${a.send}, ${now}, ${now})`,
    );
    return id;
  }

  /** Make every invoice that has come due, on the schedule, as of now. Failures raise an inbox item, once. */
  async runRecurring(orgId?: string): Promise<{ made: number; failed: number }> {
    const today = istDate(this.now());
    const orgs = orgId
      ? [{ org_id: orgId }]
      : await this.o.db
          .sql`SELECT org_id FROM (SELECT DISTINCT org_id FROM message_provider_ids UNION SELECT org_id FROM dispatch_settings) x`;
    let made = 0;
    let failed = 0;
    for (const { org_id } of orgs) {
      const oid = String(org_id);
      const rows = await this.org(
        oid,
        (tx) =>
          tx`SELECT * FROM recurring_invoices WHERE active = true AND next_run <= ${today} ORDER BY next_run`,
      );
      for (const r of rows) {
        const sched = {
          frequency: r['frequency'] as 'weekly',
          every: Number(r['every']),
          dayOfMonth: Number(r['day_of_month']),
        };
        for (const date of dueDates(String(r['next_run']), today, sched)) {
          if (r['end_date'] && date > String(r['end_date'])) {
            await this.org(
              oid,
              (tx) =>
                tx`UPDATE recurring_invoices SET active = false, updated_at = ${this.now()} WHERE id = ${r['id']}`,
            );
            break;
          }
          try {
            const docId = await this.makeInvoice(oid, r, date);
            made++;
            await this.org(
              oid,
              (tx) =>
                tx`UPDATE recurring_invoices SET next_run = ${nextRun(date, sched)}, last_run_at = ${this.now()}, last_document_id = ${docId}, last_error = NULL, runs = runs + 1, updated_at = ${this.now()} WHERE id = ${r['id']}`,
            );
            if (r['send'])
              await this.prepare({
                orgId: oid,
                businessId: String(r['business_id']),
                kind: 'invoice',
                documentId: docId,
                createdBy: 'system:recurring',
              });
          } catch (e) {
            failed++;
            const why = e instanceof Error ? e.message.slice(0, 300) : String(e);
            await this.org(
              oid,
              (tx) =>
                tx`UPDATE recurring_invoices SET last_error = ${why}, updated_at = ${this.now()} WHERE id = ${r['id']}`,
            );
            await this.raiseFailure(oid, r, date, why);
            break; // the later dates wait: they would fail the same way, and the order matters
          }
        }
      }
    }
    return { made, failed };
  }

  private async makeInvoice(orgId: string, r: Row, date: string): Promise<string> {
    const ctx = this.ctx(orgId, String(r['business_id']));
    const flow = new DocumentFlowRepo(this.o.db);
    const src = await flow.load(ctx, String(r['source_document_id']));
    if (!src) throw new Error('the invoice this one is copied from is gone');
    let n = 0;
    const draft = draftFromRows(src.document, src.lines, () => `rec${++n}`);
    // the new invoice: today's date, its own due date, no number yet, and priced again by the engine
    const next = {
      ...draft,
      date,
      dueDate: Number(r['due_days']) > 0 ? addDays(date, Number(r['due_days'])) : null,
    };
    const rows = draftToRows(next);
    const saved = await flow.saveDraft(ctx, { doc: rows.doc as never, lines: rows.lines as never });
    const issued = await flow.issueDraft(
      ctx,
      String(saved.document['id']),
      Number(saved.document['version']),
    );
    if (isProvisional(String(issued.document['number'] ?? '')))
      await flow.finaliseNumber(ctx, String(issued.document['id']));
    return String(issued.document['id']);
  }

  private async raiseFailure(orgId: string, r: Row, date: string, why: string): Promise<void> {
    const key = `recurring_failed:${r['id']}:${date}`;
    const seen = await this.org(
      orgId,
      (tx) => tx`SELECT 1 FROM review_items WHERE dedupe_key = ${key} LIMIT 1`,
    );
    if (seen.length) return;
    const ctx = this.ctx(orgId, String(r['business_id']));
    try {
      await new ReviewRepo(this.o.db).create(ctx, {
        kind: 'recurring_failed',
        status: 'pending',
        payload_json: { recurringId: r['id'], date },
        suggestion_json: {
          recurringId: String(r['id']),
          name: String(r['name']),
          date,
          message: why,
          documentId: String(r['source_document_id']),
        },
        diff_json: null,
        source: 'recurring',
        confidence: null,
        dedupe_key: key,
      });
    } catch {
      /* the same failure on the same date is already in the inbox */
    }
  }
}
