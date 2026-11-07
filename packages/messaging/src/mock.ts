import {
  advances,
  emptyEvents,
  MessagingError,
  type Channel,
  type DeliveryStatus,
  type DocumentMessage,
  type MessagingAdapter,
  type SendResult,
  type TemplateMessage,
  type WebhookEvents,
} from './types';

/** For tests and local development: records what it was asked to send and answers like a provider. */
export class MockAdapter implements MessagingAdapter {
  readonly sent: {
    kind: 'template' | 'document';
    to: string;
    key: string;
    message: TemplateMessage | DocumentMessage;
  }[] = [];
  /** Make the next sends fail: `retryable` ones are the provider being busy. */
  failNext: { retryable: boolean; message?: string }[] = [];
  private readonly byKey = new Map<string, SendResult>();
  private readonly statuses = new Map<string, DeliveryStatus>();
  private n = 0;

  constructor(readonly channel: Channel = 'whatsapp') {}

  private send(
    kind: 'template' | 'document',
    m: TemplateMessage | DocumentMessage,
  ): Promise<SendResult> {
    const fail = this.failNext.shift();
    if (fail)
      return Promise.reject(
        new MessagingError(
          fail.message ?? 'mock failure',
          fail.retryable,
          fail.retryable ? 503 : 400,
        ),
      );
    const seen = this.byKey.get(m.idempotencyKey);
    if (seen) return Promise.resolve(seen);
    const providerId = `mock-${this.channel}-${++this.n}`;
    const r: SendResult = { providerId, status: 'sent' };
    this.byKey.set(m.idempotencyKey, r);
    this.statuses.set(providerId, 'sent');
    this.sent.push({ kind, to: m.to, key: m.idempotencyKey, message: m });
    return Promise.resolve(r);
  }

  sendTemplate(m: TemplateMessage) {
    return this.send('template', m);
  }
  sendDocument(m: DocumentMessage) {
    return this.send('document', m);
  }
  getStatus(providerId: string) {
    return Promise.resolve(this.statuses.get(providerId) ?? null);
  }
  /** Move a message on, as the provider's webhook would. */
  setStatus(providerId: string, to: DeliveryStatus): void {
    const from = this.statuses.get(providerId);
    if (from && advances(from, to)) this.statuses.set(providerId, to);
  }
  verifyWebhook(): boolean {
    return true;
  }
  parseWebhook(): WebhookEvents {
    return emptyEvents();
  }
}
