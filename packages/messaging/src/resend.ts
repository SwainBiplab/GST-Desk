/**
 * Resend (prompt 44): transactional email with the PDF attached, `Idempotency-Key` so a retry never sends
 * twice, and Svix-signed webhooks for delivery, bounce, complaint and open.
 */
import { verifySvix } from './crypto';
import {
  emptyEvents,
  failure,
  MessagingError,
  type DeliveryStatus,
  type DocumentMessage,
  type FetchFn,
  type MessagingAdapter,
  type SendResult,
  type TemplateMessage,
  type WebhookEvents,
} from './types';

export interface ResendConfig {
  apiKey: string;
  /** `Name <address@domain>` on a domain verified with Resend. */
  from: string;
  /** The `whsec_...` signing secret of the webhook. */
  webhookSecret: string;
  baseUrl?: string;
}

const EVENT: Record<string, DeliveryStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'sent',
  'email.bounced': 'bounced',
  'email.complained': 'bounced',
  'email.failed': 'failed',
  'email.opened': 'opened',
};

const LAST_EVENT: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  bounced: 'bounced',
  complained: 'bounced',
  opened: 'opened',
  clicked: 'opened',
  delivery_delayed: 'sent',
  failed: 'failed',
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export class ResendEmailAdapter implements MessagingAdapter {
  readonly channel = 'email' as const;

  constructor(
    private readonly c: ResendConfig,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}

  private async request<T>(path: string, init: RequestInit, what: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.c.baseUrl ?? 'https://api.resend.com'}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.c.apiKey}`,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string>),
        },
      });
    } catch (e) {
      throw new MessagingError(
        `${what}: ${e instanceof Error ? e.message : 'network error'}`,
        true,
      );
    }
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  }

  private async mail(
    m: {
      to: string;
      subject: string;
      html?: string | undefined;
      text?: string | undefined;
      idempotencyKey: string;
    },
    doc: { fileName: string; bytes: Uint8Array } | undefined,
  ): Promise<SendResult> {
    const r = await this.request<{ id?: string }>(
      '/emails',
      {
        method: 'POST',
        headers: { 'idempotency-key': m.idempotencyKey },
        body: JSON.stringify({
          from: this.c.from,
          to: [m.to],
          subject: m.subject,
          ...(m.html ? { html: m.html } : {}),
          ...(m.text ? { text: m.text } : {}),
          ...(doc ? { attachments: [{ filename: doc.fileName, content: b64(doc.bytes) }] } : {}),
        }),
      },
      'Email send',
    );
    if (!r.id) throw new MessagingError('Email send: no id in the answer', false);
    return { providerId: r.id, status: 'sent' };
  }

  sendTemplate(m: TemplateMessage): Promise<SendResult> {
    return this.mail(
      {
        to: m.to,
        subject: m.subject ?? m.template,
        html: m.html,
        text: m.text,
        idempotencyKey: m.idempotencyKey,
      },
      m.document,
    );
  }

  sendDocument(m: DocumentMessage): Promise<SendResult> {
    return this.mail(
      {
        to: m.to,
        subject: m.subject ?? m.document.fileName,
        text: m.caption,
        idempotencyKey: m.idempotencyKey,
      },
      m.document,
    );
  }

  async getStatus(providerId: string): Promise<DeliveryStatus | null> {
    const r = await this.request<{ last_event?: string }>(
      `/emails/${encodeURIComponent(providerId)}`,
      { method: 'GET' },
      'Email status',
    );
    return LAST_EVENT[String(r.last_event ?? '')] ?? null;
  }

  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    now = Date.now(),
  ): boolean {
    return verifySvix(
      this.c.webhookSecret,
      {
        id: headers['svix-id'],
        timestamp: headers['svix-timestamp'],
        signature: headers['svix-signature'],
      },
      rawBody,
      now,
    );
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined> = {}): WebhookEvents {
    const svixId = headers['svix-id'];
    const out = emptyEvents();
    let body: {
      type?: string;
      created_at?: string;
      data?: {
        email_id?: string;
        created_at?: string;
        bounce?: { message?: string };
        reason?: string;
      };
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return out;
    }
    const status = EVENT[String(body.type ?? '')];
    const id = body.data?.email_id;
    if (!status || !id) return out;
    const at = Date.parse(body.data?.created_at ?? body.created_at ?? '') || Date.now();
    out.statuses.push({
      // the Svix id is unique per delivery attempt of the same event; the event itself is the pair
      eventId: `rs:${id}:${body.type}:${svixId ?? at}`,
      providerId: id,
      status,
      at,
      ...(status === 'bounced' || status === 'failed'
        ? {
            error: (body.data?.bounce?.message ?? body.data?.reason ?? String(body.type)).slice(
              0,
              200,
            ),
          }
        : {}),
    });
    return out;
  }
}
