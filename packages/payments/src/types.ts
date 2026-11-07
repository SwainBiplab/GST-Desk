/**
 * Payment gateways (prompt 45). A gateway turns an invoice into something a customer can pay (a link, a
 * dynamic UPI QR), tells us by webhook when the money arrived, and reports what it kept and when it paid out.
 * The app never sees card data: the customer pays on the gateway's page or in their UPI app. Amounts are
 * paise (integers) everywhere.
 */
export type Provider = 'razorpay' | 'mock';

export interface LinkInput {
  /** Our id for this request; the gateway echoes it, so a webhook finds its invoice. */
  reference: string;
  amountPaise: number;
  description: string;
  partialAllowed: boolean;
  /** Epoch milliseconds the link stops working. */
  expiresAt: number;
  customer?: { name?: string; contact?: string; email?: string };
}
export interface LinkResult {
  providerRef: string;
  url: string;
  expiresAt: number;
}

export interface QrInput {
  reference: string;
  amountPaise: number;
  description: string;
  expiresAt: number;
}
export interface QrResult {
  providerRef: string;
  /** The gateway's image of the QR. */
  imageUrl: string;
  /** What the QR encodes: a `upi://pay?...` link, so the app can draw it itself, sharp, with no image fetch. */
  payload: string;
  expiresAt: number;
}

export interface GatewayPayment {
  id: string;
  amountPaise: number;
  /** Everything the gateway keeps for this payment, GST on its fee included. */
  feePaise: number;
  /** Of `feePaise`, the GST. */
  taxPaise: number;
  method: string;
  status: 'captured' | 'authorized' | 'failed' | 'refunded' | 'created';
  /** Epoch milliseconds. */
  at: number;
}

export interface RefundInput {
  paymentId: string;
  amountPaise: number;
  /** The same key returns the same refund. */
  reference: string;
}
export interface RefundResult {
  id: string;
  status: 'processed' | 'pending' | 'failed';
  amountPaise: number;
}

export interface Settlement {
  id: string;
  amountPaise: number;
  feePaise: number;
  taxPaise: number;
  /** The bank's reference for the payout, the key to match a bank line (prompt 53). */
  utr: string | null;
  status: 'created' | 'processed' | 'failed';
  at: number;
}

/** Which of our requests an event is about. At least one is set. */
export interface RequestRef {
  linkId?: string;
  qrId?: string;
  reference?: string;
}

export type GatewayEvent =
  | { type: 'paid'; eventKey: string; request: RequestRef; payment: GatewayPayment }
  | {
      type: 'refund';
      eventKey: string;
      paymentId: string;
      refundId: string;
      amountPaise: number;
      status: RefundResult['status'];
    }
  | { type: 'settlement'; eventKey: string; settlement: Settlement };

export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface PaymentGatewayAdapter {
  readonly provider: Provider;
  createLink(i: LinkInput): Promise<LinkResult>;
  createUpiQr(i: QrInput): Promise<QrResult>;
  getPayment(id: string): Promise<GatewayPayment>;
  refund(i: RefundInput): Promise<RefundResult>;
  listSettlements(fromMs: number, toMs: number): Promise<Settlement[]>;
  /** Stop a link or QR the customer should no longer use (invoice cancelled or paid another way). */
  cancel(providerRef: string, kind: 'link' | 'qr'): Promise<void>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean;
  parseWebhook(rawBody: string, headers?: Record<string, string | undefined>): GatewayEvent[];
}
