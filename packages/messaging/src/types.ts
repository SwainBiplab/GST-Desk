/**
 * What every messaging provider has to do (prompt 44): send a template message, send a document, say where
 * a message stands, and turn the provider's webhook into status events. Adapters only talk HTTP (through an
 * injected `fetch`) and never log message content, addresses or numbers.
 */
export type Channel = 'whatsapp' | 'email';

/** In the order a message moves. `failed` and `bounced` end it; `opened` is email's own step. */
export const STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'opened',
  'failed',
  'bounced',
] as const;
export type DeliveryStatus = (typeof STATUSES)[number];

const RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  read: 3,
  failed: 9,
  bounced: 9,
};

/**
 * Providers deliver webhooks out of order and more than once: a status only moves a message forward, and
 * a failure after delivery (a late bounce) is kept as the end of the story only if nothing better arrived.
 */
export function advances(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === to) return false;
  if (RANK[from] === 9) return false;
  if (RANK[to] === 9) return RANK[from] < 2;
  return RANK[to] > RANK[from];
}

export interface Attachment {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}

export interface TemplateMessage {
  /** E.164 digits for WhatsApp, an address for email. */
  to: string;
  /** The provider's template name (WhatsApp) or the key the email body is made from. */
  template: string;
  language: string;
  /** Body variables in order: {{1}}, {{2}}... */
  variables: string[];
  /** A document in the template's header (WhatsApp), or an attachment (email). */
  document?: Attachment;
  subject?: string;
  /** Rendered text, for email bodies and previews. */
  text?: string;
  html?: string;
  /** The same key on a retry returns the same send. */
  idempotencyKey: string;
}

export interface DocumentMessage {
  to: string;
  document: Attachment;
  caption: string;
  subject?: string;
  idempotencyKey: string;
}

export interface SendResult {
  providerId: string;
  status: DeliveryStatus;
}

export interface StatusEvent {
  /** Unique per provider event, for idempotent handling. */
  eventId: string;
  providerId: string;
  status: DeliveryStatus;
  /** Epoch milliseconds the provider says it happened. */
  at: number;
  /** The provider's reason, never the content. */
  error?: string;
}

export interface ConsentEvent {
  eventId: string;
  /** Digits of the number that wrote in. */
  from: string;
  status: 'opted_in' | 'opted_out';
  at: number;
}

export interface TemplateStatusEvent {
  eventId: string;
  name: string;
  language: string;
  status: 'approved' | 'rejected' | 'pending' | 'paused';
  reason?: string;
}

export interface WebhookEvents {
  statuses: StatusEvent[];
  consents: ConsentEvent[];
  templates: TemplateStatusEvent[];
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: 'approved' | 'rejected' | 'pending' | 'paused';
  reason?: string;
}

export class MessagingError extends Error {
  constructor(
    message: string,
    /** A retry may succeed (the provider is busy or down), as opposed to a refusal that will repeat. */
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export interface MessagingAdapter {
  readonly channel: Channel;
  sendTemplate(m: TemplateMessage): Promise<SendResult>;
  sendDocument(m: DocumentMessage): Promise<SendResult>;
  /** The provider's own answer, where it has one (email); null where status only arrives by webhook. */
  getStatus(providerId: string): Promise<DeliveryStatus | null>;
  /** Signature check over the raw body: false means the request is not from the provider. */
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    now?: number,
  ): boolean;
  parseWebhook(rawBody: string, headers?: Record<string, string | undefined>): WebhookEvents;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const emptyEvents = (): WebhookEvents => ({ statuses: [], consents: [], templates: [] });

/** A refusal or an outage as an error, the same way for every provider. */
export async function failure(res: Response, what: string): Promise<MessagingError> {
  let code: string | undefined;
  let message = `${what} answered ${res.status}`;
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: number | string };
      message?: string;
      name?: string;
    };
    code = String(body.error?.code ?? body.name ?? '') || undefined;
    // the provider's reason, kept short and never echoing what was sent
    message = `${what}: ${(body.error?.message ?? body.message ?? message).slice(0, 200)}`;
  } catch {
    /* no JSON body */
  }
  return new MessagingError(message, res.status === 429 || res.status >= 500, res.status, code);
}
