/**
 * WhatsApp Business Cloud API (Meta, prompt 44). Business-started conversations need an approved template, so
 * a document goes either as the header of a template or, inside a 24-hour customer window, as a plain
 * document message. The file is uploaded to Meta first (media upload) and referenced by id.
 */
import { verifyMetaSignature } from './crypto';
import {
  emptyEvents,
  failure,
  MessagingError,
  type DeliveryStatus,
  type DocumentMessage,
  type FetchFn,
  type MessagingAdapter,
  type RemoteTemplate,
  type SendResult,
  type TemplateMessage,
  type WebhookEvents,
} from './types';

export interface WhatsAppConfig {
  phoneNumberId: string;
  /** The business account the templates belong to. */
  businessAccountId: string;
  accessToken: string;
  /** The app secret that signs webhooks. */
  appSecret: string;
  /** The string Meta sends back to confirm the webhook address. */
  verifyToken: string;
  apiVersion?: string;
  baseUrl?: string;
}

const STATUS: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

const TEMPLATE_STATUS: Record<string, 'approved' | 'rejected' | 'pending' | 'paused'> = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  PAUSED: 'paused',
  DISABLED: 'paused',
  FLAGGED: 'paused',
};

interface MetaWebhook {
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        statuses?: {
          id: string;
          status: string;
          timestamp: string;
          errors?: { code?: number; title?: string }[];
        }[];
        messages?: {
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body?: string };
        }[];
        event?: string;
        message_template_id?: number | string;
        message_template_name?: string;
        message_template_language?: string;
        reason?: string;
      };
    }[];
  }[];
}

/** Words a customer writes to stop or start messages. */
const STOP = /^\s*(stop|unsubscribe|band|ruko)\s*$/i;
const START = /^\s*(start|subscribe|yes|haan)\s*$/i;

export class WhatsAppCloudAdapter implements MessagingAdapter {
  readonly channel = 'whatsapp' as const;
  private readonly root: string;

  constructor(
    private readonly c: WhatsAppConfig,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {
    this.root = `${c.baseUrl ?? 'https://graph.facebook.com'}/${c.apiVersion ?? 'v21.0'}`;
  }

  private async call<T>(path: string, init: RequestInit, what: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.root}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.c.accessToken}`,
          ...(init.headers as Record<string, string>),
        },
      });
    } catch (e) {
      // the network, not the provider: worth another try
      throw new MessagingError(
        `${what}: ${e instanceof Error ? e.message : 'network error'}`,
        true,
      );
    }
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  }

  private async upload(doc: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', doc.mime);
    form.set(
      'file',
      new Blob([doc.bytes.slice().buffer as ArrayBuffer], { type: doc.mime }),
      doc.fileName,
    );
    const r = await this.call<{ id: string }>(
      `/${this.c.phoneNumberId}/media`,
      { method: 'POST', body: form },
      'WhatsApp media upload',
    );
    return r.id;
  }

  private async post(body: Record<string, unknown>, what: string): Promise<SendResult> {
    const r = await this.call<{ messages?: { id: string }[] }>(
      `/${this.c.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...body,
        }),
      },
      what,
    );
    const id = r.messages?.[0]?.id;
    if (!id) throw new MessagingError(`${what}: no message id in the answer`, false);
    return { providerId: id, status: 'sent' };
  }

  async sendTemplate(m: TemplateMessage): Promise<SendResult> {
    const components: Record<string, unknown>[] = [];
    if (m.document) {
      const id = await this.upload(m.document);
      components.push({
        type: 'header',
        parameters: [{ type: 'document', document: { id, filename: m.document.fileName } }],
      });
    }
    if (m.variables.length)
      components.push({
        type: 'body',
        parameters: m.variables.map((text) => ({ type: 'text', text })),
      });
    return this.post(
      {
        to: m.to,
        type: 'template',
        template: { name: m.template, language: { code: m.language }, components },
      },
      'WhatsApp template send',
    );
  }

  async sendDocument(m: DocumentMessage): Promise<SendResult> {
    const id = await this.upload(m.document);
    return this.post(
      {
        to: m.to,
        type: 'document',
        document: { id, filename: m.document.fileName, caption: m.caption },
      },
      'WhatsApp document send',
    );
  }

  /** WhatsApp has no status lookup: the answer arrives by webhook. */
  getStatus(): Promise<DeliveryStatus | null> {
    return Promise.resolve(null);
  }

  /** The confirmation Meta asks for when the webhook address is saved: echo `hub.challenge` for our token. */
  verifyChallenge(q: {
    mode?: string | null;
    token?: string | null;
    challenge?: string | null;
  }): string | null {
    return q.mode === 'subscribe' && q.token === this.c.verifyToken && q.challenge
      ? q.challenge
      : null;
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    return verifyMetaSignature(this.c.appSecret, headers['x-hub-signature-256'], rawBody);
  }

  parseWebhook(rawBody: string): WebhookEvents {
    const out = emptyEvents();
    let body: MetaWebhook;
    try {
      body = JSON.parse(rawBody) as MetaWebhook;
    } catch {
      return out;
    }
    for (const entry of body.entry ?? [])
      for (const ch of entry.changes ?? []) {
        const v = ch.value;
        if (!v) continue;
        for (const s of v.statuses ?? []) {
          const status = STATUS[s.status];
          if (!status) continue;
          const err = s.errors?.[0];
          out.statuses.push({
            // one event per message and status: Meta sends a status more than once
            eventId: `wa:${s.id}:${s.status}`,
            providerId: s.id,
            status,
            at: Number(s.timestamp) * 1000,
            ...(err ? { error: `${err.code ?? ''} ${err.title ?? ''}`.trim() } : {}),
          });
        }
        for (const msg of v.messages ?? []) {
          if (msg.type !== 'text') continue;
          const text = msg.text?.body ?? '';
          const status = STOP.test(text) ? 'opted_out' : START.test(text) ? 'opted_in' : null;
          if (status)
            out.consents.push({
              eventId: `wa:${msg.id}`,
              from: msg.from,
              status,
              at: Number(msg.timestamp) * 1000,
            });
        }
        if (ch.field === 'message_template_status_update' && v.message_template_name) {
          const status = TEMPLATE_STATUS[String(v.event ?? '').toUpperCase()];
          if (status)
            out.templates.push({
              eventId: `wat:${v.message_template_id ?? v.message_template_name}:${v.event}:${v.message_template_language}`,
              name: v.message_template_name,
              language: v.message_template_language ?? 'en',
              status,
              ...(v.reason && v.reason !== 'NONE' ? { reason: v.reason } : {}),
            });
        }
      }
    return out;
  }

  /** Templates of the business account with the status Meta holds for each. */
  async listTemplates(): Promise<RemoteTemplate[]> {
    const r = await this.call<{
      data?: {
        id: string;
        name: string;
        language: string;
        status: string;
        rejected_reason?: string;
      }[];
    }>(
      `/${this.c.businessAccountId}/message_templates?fields=name,status,language,id,rejected_reason&limit=200`,
      { method: 'GET' },
      'WhatsApp template list',
    );
    return (r.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      status: TEMPLATE_STATUS[t.status.toUpperCase()] ?? 'pending',
      ...(t.rejected_reason && t.rejected_reason !== 'NONE' ? { reason: t.rejected_reason } : {}),
    }));
  }

  /** Send a template to Meta for review (utility category: documents, receipts, reminders). */
  async submitTemplate(t: {
    name: string;
    language: string;
    body: string;
    /** One example per {{n}}: Meta asks for them. */
    examples: string[];
    documentHeader?: boolean;
  }): Promise<{ id: string; status: 'approved' | 'rejected' | 'pending' | 'paused' }> {
    const components: Record<string, unknown>[] = [];
    if (t.documentHeader)
      components.push({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [] } });
    components.push({
      type: 'BODY',
      text: t.body,
      ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}),
    });
    const r = await this.call<{ id: string; status?: string }>(
      `/${this.c.businessAccountId}/message_templates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: t.name,
          language: t.language,
          category: 'UTILITY',
          components,
        }),
      },
      'WhatsApp template submit',
    );
    return {
      id: r.id,
      status: TEMPLATE_STATUS[String(r.status ?? 'PENDING').toUpperCase()] ?? 'pending',
    };
  }
}
