/**
 * Razorpay (prompt 45): payment links, single-use UPI QR codes, payments, refunds, settlements, and webhooks.
 * Each organisation uses its own Razorpay account, so the adapter is made per request from that account's keys.
 * Written against Razorpay's public API documentation; **not yet run against a Razorpay account** (see
 * `docs/qa/payments-sandbox.md`), so the fixtures are hand-written, not recordings.
 */
import { hmacHex, safeEqual } from './crypto';
import {
  GatewayError,
  type FetchFn,
  type GatewayEvent,
  type GatewayPayment,
  type LinkInput,
  type LinkResult,
  type PaymentGatewayAdapter,
  type QrInput,
  type QrResult,
  type RefundInput,
  type RefundResult,
  type RequestRef,
  type Settlement,
} from './types';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

type Json = Record<string, any>;

const secs = (ms: number) => Math.floor(ms / 1000);

/** A test key starts `rzp_test_`; the gateway then moves no real money. */
export const razorpayMode = (keyId: string): 'test' | 'live' =>
  keyId.startsWith('rzp_test_') ? 'test' : 'live';

export class RazorpayAdapter implements PaymentGatewayAdapter {
  readonly provider = 'razorpay' as const;
  private readonly base: string;
  private readonly f: FetchFn;

  constructor(private readonly c: RazorpayConfig) {
    this.base = c.baseUrl ?? 'https://api.razorpay.com/v1';
    this.f = c.fetch ?? ((u, i) => fetch(u, i));
  }

  private async call(
    path: string,
    init: { method?: string; body?: unknown; key?: string } = {},
  ): Promise<Json> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.c.keyId}:${this.c.keySecret}`).toString('base64')}`,
          'content-type': 'application/json',
          ...(init.key ? { 'x-razorpay-idempotency': init.key } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (e) {
      throw new GatewayError(`Razorpay could not be reached: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* a non-JSON error page */
    }
    if (!res.ok) {
      const err = (json['error'] ?? {}) as Json;
      throw new GatewayError(
        String(err['description'] ?? `Razorpay answered ${res.status}`),
        res.status === 429 || res.status >= 500,
        res.status,
        typeof err['code'] === 'string' ? err['code'] : undefined,
      );
    }
    return json;
  }

  async createLink(i: LinkInput): Promise<LinkResult> {
    const r = await this.call('/payment_links', {
      method: 'POST',
      body: {
        amount: i.amountPaise,
        currency: 'INR',
        accept_partial: i.partialAllowed,
        ...(i.partialAllowed ? { first_min_partial_amount: 100 } : {}),
        expire_by: secs(i.expiresAt),
        reference_id: i.reference,
        description: i.description.slice(0, 2000),
        ...(i.customer ? { customer: i.customer } : {}),
        // we send the link ourselves, with the invoice, in the customer's language
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { request: i.reference },
      },
    });
    return { providerRef: String(r['id']), url: String(r['short_url']), expiresAt: i.expiresAt };
  }

  async createUpiQr(i: QrInput): Promise<QrResult> {
    const r = await this.call('/payments/qr_codes', {
      method: 'POST',
      body: {
        type: 'upi_qr',
        name: i.reference.slice(0, 40),
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: i.amountPaise,
        description: i.description.slice(0, 250),
        // Razorpay wants a close time at least two minutes ahead
        close_by: secs(Math.max(i.expiresAt, Date.now() + 3 * 60_000)),
        notes: { request: i.reference },
      },
    });
    return {
      providerRef: String(r['id']),
      imageUrl: String(r['image_url'] ?? ''),
      payload: String(r['image_content'] ?? ''),
      expiresAt: i.expiresAt,
    };
  }

  async getPayment(id: string): Promise<GatewayPayment> {
    return paymentOf(await this.call(`/payments/${encodeURIComponent(id)}`));
  }

  async refund(i: RefundInput): Promise<RefundResult> {
    const r = await this.call(`/payments/${encodeURIComponent(i.paymentId)}/refund`, {
      method: 'POST',
      key: i.reference,
      body: {
        amount: i.amountPaise,
        speed: 'normal',
        receipt: i.reference.slice(0, 40),
        notes: { request: i.reference },
      },
    });
    return refundOf(r);
  }

  async listSettlements(fromMs: number, toMs: number): Promise<Settlement[]> {
    const r = await this.call(`/settlements?from=${secs(fromMs)}&to=${secs(toMs)}&count=100`);
    return ((r['items'] ?? []) as Json[]).map(settlementOf);
  }

  async cancel(providerRef: string, kind: 'link' | 'qr'): Promise<void> {
    await this.call(
      kind === 'link'
        ? `/payment_links/${encodeURIComponent(providerRef)}/cancel`
        : `/payments/qr_codes/${encodeURIComponent(providerRef)}/close`,
      { method: 'POST', body: {} },
    );
  }

  /** `X-Razorpay-Signature` is the hex HMAC-SHA256 of the raw body under the webhook secret. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    const sig = headers['x-razorpay-signature'];
    return (
      !!this.c.webhookSecret && !!sig && safeEqual(sig, hmacHex(this.c.webhookSecret, rawBody))
    );
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined> = {}): GatewayEvent[] {
    const body = JSON.parse(rawBody) as Json;
    const event = String(body['event'] ?? '');
    const p = (body['payload'] ?? {}) as Json;
    const id = headers['x-razorpay-event-id'];
    const key = (suffix: string) => `razorpay:${id ?? `${event}:${suffix}`}`;
    const pay = p['payment']?.['entity'] as Json | undefined;

    if (event === 'payment_link.paid' && pay) {
      const link = (p['payment_link']?.['entity'] ?? {}) as Json;
      const request: RequestRef = {
        linkId: String(link['id']),
        ...(link['reference_id'] ? { reference: String(link['reference_id']) } : {}),
      };
      return [{ type: 'paid', eventKey: key(String(pay['id'])), request, payment: paymentOf(pay) }];
    }
    if (event === 'qr_code.credited' && pay) {
      const qr = (p['qr_code']?.['entity'] ?? {}) as Json;
      const ref = (qr['notes'] as Json | undefined)?.['request'];
      return [
        {
          type: 'paid',
          eventKey: key(String(pay['id'])),
          request: { qrId: String(qr['id']), ...(ref ? { reference: String(ref) } : {}) },
          payment: paymentOf(pay),
        },
      ];
    }
    if ((event === 'refund.processed' || event === 'refund.failed') && p['refund']?.['entity']) {
      const r = refundOf(p['refund']['entity'] as Json);
      const pid = String((p['refund']['entity'] as Json)['payment_id'] ?? '');
      return [
        {
          type: 'refund',
          eventKey: key(r.id),
          paymentId: pid,
          refundId: r.id,
          amountPaise: r.amountPaise,
          status: event === 'refund.failed' ? 'failed' : r.status,
        },
      ];
    }
    if (event === 'settlement.processed' && p['settlement']?.['entity']) {
      const s = settlementOf(p['settlement']['entity'] as Json);
      return [{ type: 'settlement', eventKey: key(s.id), settlement: s }];
    }
    return []; // payment.captured and the rest: the events above carry the same payment, once
  }
}

function paymentOf(r: Json): GatewayPayment {
  const status = String(r['status'] ?? 'created');
  return {
    id: String(r['id']),
    amountPaise: Number(r['amount'] ?? 0),
    feePaise: Number(r['fee'] ?? 0),
    taxPaise: Number(r['tax'] ?? 0),
    method: String(r['method'] ?? 'unknown'),
    status:
      (['captured', 'authorized', 'failed', 'refunded', 'created'] as const).find(
        (s) => s === status,
      ) ?? 'created',
    at: Number(r['created_at'] ?? 0) * 1000,
  };
}

function refundOf(r: Json): RefundResult {
  const s = String(r['status'] ?? 'pending');
  return {
    id: String(r['id']),
    status: s === 'processed' ? 'processed' : s === 'failed' ? 'failed' : 'pending',
    amountPaise: Number(r['amount'] ?? 0),
  };
}

function settlementOf(r: Json): Settlement {
  const s = String(r['status'] ?? 'created');
  return {
    id: String(r['id']),
    amountPaise: Number(r['amount'] ?? 0),
    feePaise: Number(r['fees'] ?? 0),
    taxPaise: Number(r['tax'] ?? 0),
    utr: r['utr'] ? String(r['utr']) : null,
    status: s === 'processed' ? 'processed' : s === 'failed' ? 'failed' : 'created',
    at: Number(r['created_at'] ?? 0) * 1000,
  };
}
