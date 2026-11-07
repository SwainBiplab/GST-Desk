import { hmacHex, safeEqual } from './crypto';
import type {
  GatewayEvent,
  GatewayPayment,
  LinkInput,
  LinkResult,
  PaymentGatewayAdapter,
  QrInput,
  QrResult,
  RefundInput,
  RefundResult,
  Settlement,
} from './types';

export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

/**
 * An in-memory gateway for tests and demos. `payBody` builds the webhook a real payment would cause, signed
 * the way `verifyWebhook` expects, so a test can post it twice and see the second one change nothing.
 */
export class MockGateway implements PaymentGatewayAdapter {
  readonly provider = 'mock' as const;
  links: (LinkInput & { id: string })[] = [];
  qrs: (QrInput & { id: string })[] = [];
  refunds = new Map<string, RefundResult & { paymentId: string }>();
  settlements: Settlement[] = [];
  payments = new Map<string, GatewayPayment>();
  cancelled: string[] = [];
  failNext: Error[] = [];
  private n = 0;

  private maybeFail(): void {
    const e = this.failNext.shift();
    if (e) throw e;
  }

  async createLink(i: LinkInput): Promise<LinkResult> {
    this.maybeFail();
    const id = `plink_mock${++this.n}`;
    this.links.push({ ...i, id });
    return { providerRef: id, url: `https://pay.example/${id}`, expiresAt: i.expiresAt };
  }

  async createUpiQr(i: QrInput): Promise<QrResult> {
    this.maybeFail();
    const id = `qr_mock${++this.n}`;
    this.qrs.push({ ...i, id });
    return {
      providerRef: id,
      imageUrl: `https://pay.example/${id}.png`,
      payload: `upi://pay?pa=mock@bank&pn=Mock&am=${(i.amountPaise / 100).toFixed(2)}&cu=INR&tr=${id}`,
      expiresAt: i.expiresAt,
    };
  }

  async getPayment(id: string): Promise<GatewayPayment> {
    const p = this.payments.get(id);
    if (!p) throw new Error('no such payment');
    return p;
  }

  async refund(i: RefundInput): Promise<RefundResult> {
    this.maybeFail();
    const existing = [...this.refunds.values()].find((r) => r.id === `rfnd_${i.reference}`);
    if (existing) return existing;
    const r = {
      id: `rfnd_${i.reference}`,
      status: 'processed' as const,
      amountPaise: i.amountPaise,
      paymentId: i.paymentId,
    };
    this.refunds.set(r.id, r);
    return r;
  }

  async listSettlements(): Promise<Settlement[]> {
    return this.settlements;
  }

  async cancel(ref: string): Promise<void> {
    this.cancelled.push(ref);
  }

  verifyWebhook(h: Record<string, string | undefined>, raw: string): boolean {
    const s = h['x-razorpay-signature'];
    return !!s && safeEqual(s, hmacHex(MOCK_WEBHOOK_SECRET, raw));
  }

  parseWebhook(raw: string): GatewayEvent[] {
    return JSON.parse(raw) as GatewayEvent[];
  }

  /** The signed webhook for a payment of `amountPaise` against a link or QR this gateway made. */
  payBody(
    ref: { linkId?: string; qrId?: string },
    amountPaise: number,
    o: { paymentId?: string; feePaise?: number; eventKey?: string } = {},
  ): { raw: string; headers: Record<string, string> } {
    const id = o.paymentId ?? `pay_mock${++this.n}`;
    const payment: GatewayPayment = {
      id,
      amountPaise,
      feePaise: o.feePaise ?? Math.round(amountPaise * 0.0236),
      taxPaise: Math.round((o.feePaise ?? Math.round(amountPaise * 0.0236)) * (18 / 118)),
      method: 'upi',
      status: 'captured',
      at: Date.now(),
    };
    this.payments.set(id, payment);
    const events: GatewayEvent[] = [
      { type: 'paid', eventKey: o.eventKey ?? `mock:${id}`, request: ref, payment },
    ];
    const raw = JSON.stringify(events);
    return { raw, headers: { 'x-razorpay-signature': hmacHex(MOCK_WEBHOOK_SECRET, raw) } };
  }
}
