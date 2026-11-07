/**
 * Payment collection (prompt 45). A business connects its own gateway account; an invoice gets a payment link or
 * a dynamic UPI QR; the gateway's webhook says when money arrived, and this turns it into a payment allocated to
 * the invoice, with the gateway's fee posted as an expense. Every table is read under the organisation's
 * row-level security. A webhook can arrive twice, late, or out of order: a payment is keyed by the provider's id,
 * so the second one finds the first and changes nothing. Nothing here logs a key, a secret or a customer detail.
 */
import { DocumentFlowRepo, PaymentFlowRepo, ReviewRepo, newId, type Ctx, type Row } from '@gst/db';
import { istDate } from '@gst/messaging';
import {
  GatewayError,
  RazorpayAdapter,
  openSecret,
  razorpayMode,
  sealSecret,
  type GatewayEvent,
  type GatewayPayment,
  type PaymentGatewayAdapter,
  type Settlement,
} from '@gst/payments';
import type { Logger } from 'pino';

import type { PgDatabase } from '../db/pool';

export type Kind = 'link' | 'qr';

export interface ServiceOptions {
  db: PgDatabase;
  /** Base64 of 32 bytes: seals the gateway secrets. Without it, nothing can be connected. */
  secretsKey: string | null;
  log: Logger;
  now?: () => number;
  /** The adapter for a business's account; tests pass a mock. */
  adapterFor?: (g: {
    provider: string;
    keyId: string;
    keySecret: string;
    webhookSecret: string;
  }) => PaymentGatewayAdapter;
  /** A payment was recorded against an invoice (the receipt message is sent from here). */
  onPaid?: (a: {
    orgId: string;
    businessId: string;
    paymentId: string;
    documentId: string;
  }) => Promise<void>;
}

export interface GatewayStatus {
  connected: boolean;
  configured: boolean;
  provider: string | null;
  mode: 'test' | 'live' | null;
  active: boolean;
  keyId: string | null;
  lastError: string | null;
  lastOkAt: number | null;
  /** The path to give the gateway as its webhook address (on this API's host). */
  webhookPath: string | null;
}

export class PaymentsError extends Error {
  override name = 'PaymentsError';
  constructor(
    message: string,
    readonly code:
      'no_gateway' | 'no_document' | 'not_payable' | 'not_found' | 'rule' | 'gateway' | 'no_key',
  ) {
    super(message);
  }
}

const DAY = 86_400_000;
const mapMethod = (m: string) =>
  m === 'upi' ? 'upi' : m === 'card' ? 'card' : m === 'netbanking' ? 'bank' : 'other';

export class PaymentsService {
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

  private ctx(orgId: string, businessId: string, actor = 'system:payments'): Ctx {
    return { orgId, businessId, actor, deviceId: 'api' };
  }

  private key(): string {
    if (!this.o.secretsKey)
      throw new PaymentsError('Payment collection is not set up on this server.', 'no_key');
    return this.o.secretsKey;
  }

  private build(g: Row, orgId: string): PaymentGatewayAdapter {
    const k = this.key();
    const creds = {
      provider: String(g['provider']),
      keyId: String(g['key_id']),
      keySecret: openSecret(String(g['key_secret_enc']), k, orgId),
      webhookSecret: openSecret(String(g['webhook_secret_enc']), k, orgId),
    };
    return this.o.adapterFor ? this.o.adapterFor(creds) : new RazorpayAdapter(creds);
  }

  private async gatewayRow(orgId: string, businessId: string): Promise<Row | null> {
    const [g] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM payment_gateways WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    return g ?? null;
  }

  private async adapter(
    orgId: string,
    businessId: string,
  ): Promise<{ row: Row; gw: PaymentGatewayAdapter }> {
    const row = await this.gatewayRow(orgId, businessId);
    if (!row || !row['active'])
      throw new PaymentsError('Connect a payment gateway in Settings first.', 'no_gateway');
    return { row, gw: this.build(row, orgId) };
  }

  /** Run a gateway call and keep the outcome where the settings screen can show it. */
  private async viaGateway<T>(row: Row, orgId: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE payment_gateways SET last_error = NULL, last_ok_at = ${this.now()} WHERE id = ${row['id']}`,
      );
      return out;
    } catch (e) {
      const why = e instanceof Error ? e.message.slice(0, 300) : String(e);
      await this.org(
        orgId,
        (tx) => tx`UPDATE payment_gateways SET last_error = ${why} WHERE id = ${row['id']}`,
      );
      if (e instanceof GatewayError) throw new PaymentsError(e.message, 'gateway');
      throw e;
    }
  }

  /* --------------------------------------------------------------------------------- connect */

  async status(orgId: string, businessId: string): Promise<GatewayStatus> {
    const g = await this.gatewayRow(orgId, businessId);
    return {
      connected: !!g,
      configured: !!this.o.secretsKey,
      provider: g ? String(g['provider']) : null,
      mode: g ? (String(g['mode']) as 'test' | 'live') : null,
      active: !!g?.['active'],
      keyId: g ? String(g['key_id']) : null,
      lastError: (g?.['last_error'] as string | null) ?? null,
      lastOkAt: g?.['last_ok_at'] == null ? null : Number(g['last_ok_at']),
      webhookPath: g ? `/v1/webhooks/razorpay/${g['id']}` : null,
    };
  }

  /** Save the account's keys, sealed. The secrets are never returned again. */
  async connect(
    orgId: string,
    businessId: string,
    c: { keyId: string; keySecret: string; webhookSecret: string },
  ): Promise<GatewayStatus> {
    const k = this.key();
    const mode = razorpayMode(c.keyId);
    const now = this.now();
    await this.org(
      orgId,
      (tx) => tx`
        INSERT INTO payment_gateways (id, org_id, business_id, provider, key_id, key_secret_enc, webhook_secret_enc, mode, created_at, updated_at)
        VALUES (${newId()}, ${orgId}, ${businessId}, 'razorpay', ${c.keyId}, ${sealSecret(c.keySecret, k, orgId)}, ${sealSecret(c.webhookSecret, k, orgId)}, ${mode}, ${now}, ${now})
        ON CONFLICT (org_id, business_id) DO UPDATE SET key_id = EXCLUDED.key_id, key_secret_enc = EXCLUDED.key_secret_enc,
          webhook_secret_enc = EXCLUDED.webhook_secret_enc, mode = EXCLUDED.mode, active = true, last_error = NULL, updated_at = ${now}`,
    );
    return this.status(orgId, businessId);
  }

  async disconnect(orgId: string, businessId: string): Promise<void> {
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE payment_gateways SET active = false, updated_at = ${this.now()} WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
  }

  /* --------------------------------------------------------------------------------- requests */

  /** What is still owed on an invoice, from the book as the server holds it. */
  private async owed(orgId: string, businessId: string, documentId: string) {
    const ctx = this.ctx(orgId, businessId);
    const flow = new DocumentFlowRepo(this.o.db);
    const loaded = await flow.load(ctx, documentId);
    if (!loaded) throw new PaymentsError('That invoice is not on the server.', 'no_document');
    const doc = loaded.document;
    const today = istDate(this.now());
    const { documents } = await new PaymentFlowRepo(this.o.db).positions(ctx, today);
    const pos = documents.find((d) => d.id === documentId);
    if (!pos || doc['status'] !== 'issued' || pos.balancePaise <= 0n)
      throw new PaymentsError(
        'Only an issued invoice with something owed can be collected.',
        'not_payable',
      );
    return { doc, pos };
  }

  async createRequest(a: {
    orgId: string;
    businessId: string;
    documentId: string;
    kind: Kind;
    partialAllowed?: boolean | undefined;
    expiresInDays?: number | undefined;
    by: string;
  }) {
    const { row, gw } = await this.adapter(a.orgId, a.businessId);
    const { doc, pos } = await this.owed(a.orgId, a.businessId, a.documentId);
    const amount = Number(pos.balancePaise);
    const now = this.now();

    // the same ask twice is one request
    const [live] = await this.org(
      a.orgId,
      (
        tx,
      ) => tx`SELECT * FROM payment_requests WHERE org_id = ${a.orgId} AND document_id = ${a.documentId}
        AND kind = ${a.kind} AND status IN ('created', 'partial') AND expires_at > ${now} AND amount_paise = ${amount}
        ORDER BY created_at DESC LIMIT 1`,
    );
    if (live) return this.view(live);

    const id = newId();
    const expiresAt = now + (a.kind === 'qr' ? 1 : (a.expiresInDays ?? 7)) * DAY;
    const description = `Invoice ${doc['number'] ?? ''}`.trim();
    const made = await this.viaGateway<{
      providerRef: string;
      expiresAt: number;
      url?: string;
      imageUrl?: string;
      payload?: string;
    }>(row, a.orgId, () =>
      a.kind === 'link'
        ? gw.createLink({
            reference: id,
            amountPaise: amount,
            description,
            partialAllowed: !!a.partialAllowed,
            expiresAt,
          })
        : gw.createUpiQr({ reference: id, amountPaise: amount, description, expiresAt }),
    );
    // a link's address, or a QR's UPI payload (the app draws the QR from it)
    const url = made.url ?? made.payload ?? null;
    const imageUrl = made.imageUrl ?? null;
    await this.org(
      a.orgId,
      (
        tx,
      ) => tx`INSERT INTO payment_requests (id, org_id, business_id, gateway_id, document_id, party_id, kind, provider_ref, url, image_url,
          amount_paise, partial_allowed, expires_at, created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${row['id']}, ${a.documentId}, ${pos.partyId}, ${a.kind}, ${made.providerRef}, ${url}, ${imageUrl},
          ${amount}, ${!!a.partialAllowed && a.kind === 'link'}, ${made.expiresAt}, ${a.by}, ${now}, ${now})`,
    );
    return this.request(a.orgId, id);
  }

  private view(r: Row) {
    const expired =
      ['created', 'partial'].includes(String(r['status'])) && Number(r['expires_at']) <= this.now();
    return {
      id: String(r['id']),
      documentId: String(r['document_id']),
      kind: String(r['kind']) as Kind,
      url: (r['url'] as string | null) ?? null,
      imageUrl: (r['image_url'] as string | null) ?? null,
      amountPaise: Number(r['amount_paise']),
      paidPaise: Number(r['paid_paise']),
      partialAllowed: !!r['partial_allowed'],
      expiresAt: Number(r['expires_at']),
      status: expired ? 'expired' : String(r['status']),
    };
  }

  async request(orgId: string, id: string) {
    const [r] = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM payment_requests WHERE org_id = ${orgId} AND id = ${id}`,
    );
    if (!r) throw new PaymentsError('No such payment request.', 'not_found');
    return this.view(r);
  }

  async requestsFor(orgId: string, documentId: string) {
    const rows = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM payment_requests WHERE org_id = ${orgId} AND document_id = ${documentId} ORDER BY created_at DESC LIMIT 20`,
    );
    return (rows as Row[]).map((r) => this.view(r));
  }

  /** Stop what the customer could still pay: the invoice is cancelled, or was paid another way. */
  async cancelRequests(orgId: string, businessId: string, documentId: string): Promise<number> {
    const live: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM payment_requests WHERE org_id = ${orgId} AND document_id = ${documentId} AND status IN ('created', 'partial')`,
    );
    if (!live.length) return 0;
    let adapter: { row: Row; gw: PaymentGatewayAdapter } | null = null;
    try {
      adapter = await this.adapter(orgId, businessId);
    } catch {
      /* disconnected: the requests are closed on our side all the same */
    }
    for (const r of live) {
      try {
        await adapter?.gw.cancel(String(r['provider_ref']), String(r['kind']) as Kind);
      } catch (e) {
        this.o.log.warn(
          { requestId: r['id'], err: (e as Error).message },
          'could not close a payment request at the gateway',
        );
      }
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE payment_requests SET status = 'cancelled', updated_at = ${this.now()} WHERE id = ${r['id']}`,
      );
    }
    return live.length;
  }

  /* --------------------------------------------------------------------------------- webhooks */

  /** The organisation, business and sealed webhook secret of the gateway an address names. */
  async webhookKey(gatewayId: string): Promise<{
    orgId: string;
    businessId: string;
    gw: PaymentGatewayAdapter;
  } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(gatewayId)) return null;
    const [k] = await this.o.db
      .sql`SELECT * FROM gateway_webhook_keys WHERE id = ${gatewayId} AND active`;
    if (!k) return null;
    const orgId = String(k['org_id']);
    const row = await this.gatewayRow(orgId, String(k['business_id']));
    if (!row) return null;
    return { orgId, businessId: String(k['business_id']), gw: this.build(row, orgId) };
  }

  async applyEvents(
    orgId: string,
    businessId: string,
    gatewayId: string,
    events: GatewayEvent[],
  ): Promise<{ applied: number; duplicates: number }> {
    let applied = 0;
    let duplicates = 0;
    for (const ev of events) {
      const done =
        ev.type === 'paid'
          ? await this.applyPaid(orgId, businessId, gatewayId, ev.payment, ev.request)
          : ev.type === 'refund'
            ? await this.applyRefund(orgId, businessId, ev)
            : await this.applySettlement(orgId, businessId, gatewayId, ev.settlement);
      if (done) applied++;
      else duplicates++;
    }
    return { applied, duplicates };
  }

  private async applyPaid(
    orgId: string,
    businessId: string,
    gatewayId: string,
    p: GatewayPayment,
    ref: { linkId?: string; qrId?: string; reference?: string },
  ): Promise<boolean> {
    if (p.status !== 'captured') return false;
    // One delivery at a time works on a payment: the claim is a single atomic update, so a second or third
    // delivery of the same payment (the gateway retries, or sends it twice at once) finds it taken and stops.
    const now = this.now();
    const gpId = await this.org(orgId, async (tx) => {
      const [row] =
        await tx`INSERT INTO gateway_payments (id, org_id, business_id, gateway_id, provider_payment_id, amount_paise, fee_paise, tax_paise, method, status, claimed_at, at, created_at)
        VALUES (${newId()}, ${orgId}, ${businessId}, ${gatewayId}, ${p.id}, ${p.amountPaise}, ${p.feePaise}, ${p.taxPaise}, ${p.method}, 'processing', ${now}, ${p.at || now}, ${now})
        ON CONFLICT (gateway_id, provider_payment_id) DO UPDATE SET status = 'processing', claimed_at = ${now}
          WHERE gateway_payments.status = 'received' OR (gateway_payments.status = 'processing' AND gateway_payments.claimed_at < ${now - 60_000})
        RETURNING id`;
      return row ? String(row['id']) : null;
    });
    if (!gpId) return false;
    try {
      return await this.settlePaid(orgId, businessId, gatewayId, gpId, p, ref);
    } catch (e) {
      // let the gateway's next delivery try again straight away
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE gateway_payments SET status = 'received' WHERE id = ${gpId} AND status = 'processing'`,
      );
      throw e;
    }
  }

  private async settlePaid(
    orgId: string,
    businessId: string,
    gatewayId: string,
    gpId: string,
    p: GatewayPayment,
    ref: { linkId?: string; qrId?: string; reference?: string },
  ): Promise<boolean> {
    const [req]: Row[] = await this.org(
      orgId,
      (
        tx,
      ) => tx`SELECT * FROM payment_requests WHERE org_id = ${orgId} AND gateway_id = ${gatewayId}
        AND (provider_ref = ${ref.linkId ?? ref.qrId ?? ''} OR id::text = ${ref.reference ?? ''}) LIMIT 1`,
    );
    if (!req)
      return this.unmatched(orgId, businessId, gpId, p, 'No invoice is waiting for this payment.');

    const documentId = String(req['document_id']);
    const ctx = this.ctx(orgId, businessId);
    const flow = new PaymentFlowRepo(this.o.db);
    const today = istDate(p.at || this.now());
    const { documents } = await flow.positions(ctx, today);
    const pos = documents.find((d) => d.id === documentId);
    if (!pos?.partyId)
      return this.unmatched(
        orgId,
        businessId,
        gpId,
        p,
        'The invoice is cancelled, gone, or has no customer to credit.',
        documentId,
      );

    const owed = pos.balancePaise > 0n ? pos.balancePaise : 0n;
    const amount = BigInt(p.amountPaise);
    const allocate = amount < owed ? amount : owed;
    const fee = BigInt(p.feePaise);
    // a delivery that died after recording the payment but before saying so: adopt that payment, do not record again
    const [prior] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT id FROM payments WHERE business_id = ${businessId} AND reference = ${p.id} AND deleted_at IS NULL LIMIT 1`,
    );
    const out = prior
      ? { payment: { id: prior['id'] } as Row, remainderPaise: 0n }
      : await flow.record(ctx, {
          direction: 'received',
          partyId: pos.partyId,
          date: today,
          mode: mapMethod(p.method),
          amountPaise: amount,
          ...(fee > 0n && fee < amount ? { gatewayFeePaise: fee } : {}),
          reference: p.id,
          notes: 'Paid online',
          allocations: allocate > 0n ? [{ documentId, amountPaise: allocate }] : [],
        });
    const paymentId = String(out.payment['id']);
    const paid = Number(req['paid_paise']) + p.amountPaise;
    await this.org(orgId, async (tx) => {
      await tx`UPDATE gateway_payments SET status = 'matched', payment_id = ${paymentId}, request_id = ${req['id']}, document_id = ${documentId}, party_id = ${pos.partyId} WHERE id = ${gpId}`;
      await tx`UPDATE payment_requests SET paid_paise = ${paid}, status = ${paid >= Number(req['amount_paise']) ? 'paid' : 'partial'}, updated_at = ${this.now()} WHERE id = ${req['id']}`;
    });

    const left = prior ? 0n : owed - allocate;
    if (out.remainderPaise > 0n)
      await this.attention(orgId, businessId, gpId, {
        reason: 'overpaid',
        amountPaise: Number(out.remainderPaise),
        documentId,
        number: (pos.number as string | null) ?? null,
        message: 'More was paid than the invoice owed; the rest is credit on the customer.',
        providerPaymentId: p.id,
      });
    else if (left > 0n)
      await this.attention(orgId, businessId, gpId, {
        reason: 'partial',
        amountPaise: Number(left),
        documentId,
        number: (pos.number as string | null) ?? null,
        message: 'Paid in part; this much is still owed.',
        providerPaymentId: p.id,
      });
    if (left <= 0n) await this.closeOthers(orgId, businessId, documentId, String(req['id']));
    await this.o
      .onPaid?.({ orgId, businessId, paymentId, documentId })
      .catch((e: Error) =>
        this.o.log.warn({ paymentId, err: e.message }, 'the receipt could not be queued'),
      );
    return true;
  }

  /** The invoice is paid: the other link or QR for it should not take money a second time. */
  private async closeOthers(orgId: string, businessId: string, documentId: string, except: string) {
    const rows: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT id, provider_ref, kind FROM payment_requests WHERE org_id = ${orgId} AND document_id = ${documentId} AND id <> ${except} AND status IN ('created', 'partial')`,
    );
    if (!rows.length) return;
    let gw: PaymentGatewayAdapter | null = null;
    try {
      gw = (await this.adapter(orgId, businessId)).gw;
    } catch {
      /* disconnected */
    }
    for (const r of rows) {
      await gw?.cancel(String(r['provider_ref']), String(r['kind']) as Kind).catch(() => undefined);
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE payment_requests SET status = 'cancelled', updated_at = ${this.now()} WHERE id = ${r['id']}`,
      );
    }
  }

  private async unmatched(
    orgId: string,
    businessId: string,
    gpId: string,
    p: GatewayPayment,
    message: string,
    documentId: string | null = null,
  ): Promise<boolean> {
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE gateway_payments SET status = 'unmatched', document_id = ${documentId} WHERE id = ${gpId}`,
    );
    await this.attention(orgId, businessId, gpId, {
      reason: 'unmatched',
      amountPaise: p.amountPaise,
      documentId,
      number: null,
      message,
      providerPaymentId: p.id,
    });
    return true;
  }

  private async attention(
    orgId: string,
    businessId: string,
    key: string,
    item: {
      reason: 'unmatched' | 'partial' | 'overpaid' | 'refund_failed';
      amountPaise: number;
      documentId: string | null;
      number: string | null;
      message: string;
      providerPaymentId: string;
    },
  ): Promise<void> {
    try {
      await new ReviewRepo(this.o.db).create(this.ctx(orgId, businessId), {
        kind: 'payment_attention',
        status: 'pending',
        payload_json: { providerPaymentId: item.providerPaymentId },
        suggestion_json: item,
        diff_json: null,
        source: 'gateway',
        confidence: null,
        dedupe_key: `payment_attention:${key}:${item.reason}`,
      });
    } catch {
      /* the same thing is already in the inbox */
    }
  }

  /* --------------------------------------------------------------------------------- settlements */

  private async applySettlement(
    orgId: string,
    businessId: string,
    gatewayId: string,
    s: Settlement,
  ): Promise<boolean> {
    return this.org(orgId, async (tx) => {
      const [had] =
        await tx`SELECT matched FROM gateway_settlements WHERE gateway_id = ${gatewayId} AND provider_id = ${s.id}`;
      await tx`INSERT INTO gateway_settlements (gateway_id, provider_id, org_id, business_id, amount_paise, fee_paise, tax_paise, utr, status, at)
        VALUES (${gatewayId}, ${s.id}, ${orgId}, ${businessId}, ${s.amountPaise}, ${s.feePaise}, ${s.taxPaise}, ${s.utr}, ${s.status}, ${s.at})
        ON CONFLICT (gateway_id, provider_id) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, fee_paise = EXCLUDED.fee_paise,
          tax_paise = EXCLUDED.tax_paise, utr = EXCLUDED.utr, status = EXCLUDED.status`;
      return !had;
    });
  }

  /**
   * Fetch the last 30 days of payouts and say, for each, whether the payments we hold add up to it. The gateway
   * pays out the money less its fees, so the expected figure is the sum of the payments it names minus their
   * fees. A payout that does not match is a difference to look at, not an error.
   */
  async syncSettlements(orgId: string, businessId: string) {
    const { row, gw } = await this.adapter(orgId, businessId);
    const to = this.now();
    const list = await this.viaGateway(row, orgId, () => gw.listSettlements(to - 30 * DAY, to));
    for (const s of list) await this.applySettlement(orgId, businessId, String(row['id']), s);
    return this.settlements(orgId, businessId);
  }

  /** Tell us which of our payments a payout covers (the gateway names them on the settlement report). */
  async tagSettlement(
    orgId: string,
    gatewayId: string,
    settlementId: string,
    providerPaymentIds: string[],
  ) {
    return this.org(orgId, async (tx) => {
      await tx`UPDATE gateway_payments SET settlement_id = ${settlementId} WHERE gateway_id = ${gatewayId} AND provider_payment_id = ANY(${providerPaymentIds})`;
      const [t] =
        await tx`SELECT coalesce(sum(amount_paise - fee_paise), 0)::bigint AS n FROM gateway_payments WHERE gateway_id = ${gatewayId} AND settlement_id = ${settlementId}`;
      const expected = Number(t['n']);
      const [s] =
        await tx`SELECT amount_paise FROM gateway_settlements WHERE gateway_id = ${gatewayId} AND provider_id = ${settlementId}`;
      await tx`UPDATE gateway_settlements SET expected_paise = ${expected}, matched = ${!!s && Number(s['amount_paise']) === expected} WHERE gateway_id = ${gatewayId} AND provider_id = ${settlementId}`;
      return { expectedPaise: expected, matched: !!s && Number(s['amount_paise']) === expected };
    });
  }

  async settlements(orgId: string, businessId: string) {
    const rows: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM gateway_settlements WHERE org_id = ${orgId} AND business_id = ${businessId} ORDER BY at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      id: String(r['provider_id']),
      amountPaise: Number(r['amount_paise']),
      feePaise: Number(r['fee_paise']),
      utr: (r['utr'] as string | null) ?? null,
      status: String(r['status']),
      at: Number(r['at']),
      expectedPaise: r['expected_paise'] == null ? null : Number(r['expected_paise']),
      matched: !!r['matched'],
    }));
  }

  async gatewayPayments(orgId: string, businessId: string, status?: string) {
    const rows: Row[] = await this.org(
      orgId,
      (
        tx,
      ) => tx`SELECT * FROM gateway_payments WHERE org_id = ${orgId} AND business_id = ${businessId}
        ${status ? tx`AND status = ${status}` : tx``} ORDER BY at DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      id: String(r['id']),
      providerPaymentId: String(r['provider_payment_id']),
      documentId: (r['document_id'] as string | null) ?? null,
      partyId: (r['party_id'] as string | null) ?? null,
      amountPaise: Number(r['amount_paise']),
      feePaise: Number(r['fee_paise']),
      refundedPaise: Number(r['refunded_paise']),
      method: String(r['method']),
      status: String(r['status']),
      settlementId: (r['settlement_id'] as string | null) ?? null,
      at: Number(r['at']),
    }));
  }

  /* --------------------------------------------------------------------------------- refunds */

  async requestRefund(a: {
    orgId: string;
    businessId: string;
    gatewayPaymentId: string;
    creditNoteId: string;
    amountPaise: number;
    by: string;
  }) {
    if (!Number.isInteger(a.amountPaise) || a.amountPaise <= 0)
      throw new PaymentsError('The refund must be more than zero.', 'rule');
    const ctx = this.ctx(a.orgId, a.businessId);
    const [gp] = await this.org(
      a.orgId,
      (tx) =>
        tx`SELECT * FROM gateway_payments WHERE org_id = ${a.orgId} AND id = ${a.gatewayPaymentId}`,
    );
    if (!gp || gp['status'] !== 'matched')
      throw new PaymentsError('That online payment is not on an invoice.', 'not_found');
    const { credits } = await new PaymentFlowRepo(this.o.db).positions(ctx, istDate(this.now()));
    const note = credits.find((c) => c.id === a.creditNoteId && c.type === 'credit_note');
    if (!note || note.partyId !== gp['party_id'])
      throw new PaymentsError("That credit note is not this customer's, or is not open.", 'rule');
    const [open] = await this.org(
      a.orgId,
      (tx) =>
        tx`SELECT coalesce(sum(amount_paise), 0)::bigint AS n FROM gateway_refunds WHERE gateway_payment_id = ${a.gatewayPaymentId} AND status IN ('requested', 'processing', 'processed')`,
    );
    const room = Number(gp['amount_paise']) - Number(open['n']);
    if (a.amountPaise > room)
      throw new PaymentsError(`Only ${room} paise of this payment can still be refunded.`, 'rule');
    if (BigInt(a.amountPaise) > note.balancePaise)
      throw new PaymentsError(
        `Only ${note.balancePaise} paise are left on the credit note.`,
        'rule',
      );
    const id = newId();
    const now = this.now();
    await this.org(
      a.orgId,
      (
        tx,
      ) => tx`INSERT INTO gateway_refunds (id, org_id, business_id, gateway_id, gateway_payment_id, credit_note_id, amount_paise, requested_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${gp['gateway_id']}, ${a.gatewayPaymentId}, ${a.creditNoteId}, ${a.amountPaise}, ${a.by}, ${now}, ${now})`,
    );
    return id;
  }

  async refunds(orgId: string, businessId: string) {
    const rows: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM gateway_refunds WHERE org_id = ${orgId} AND business_id = ${businessId} ORDER BY created_at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      id: String(r['id']),
      gatewayPaymentId: String(r['gateway_payment_id']),
      creditNoteId: String(r['credit_note_id']),
      amountPaise: Number(r['amount_paise']),
      status: String(r['status']),
      error: (r['error'] as string | null) ?? null,
      requestedBy: String(r['requested_by']),
      decidedBy: (r['decided_by'] as string | null) ?? null,
      createdAt: Number(r['created_at']),
    }));
  }

  async rejectRefund(orgId: string, id: string, by: string): Promise<void> {
    const n = await this.org(
      orgId,
      (tx) =>
        tx`UPDATE gateway_refunds SET status = 'rejected', decided_by = ${by}, decided_at = ${this.now()}, updated_at = ${this.now()} WHERE org_id = ${orgId} AND id = ${id} AND status = 'requested' RETURNING id`,
    );
    if (!n.length)
      throw new PaymentsError('That refund is not waiting for a decision.', 'not_found');
  }

  /**
   * Approve: the gateway pays the customer back and the books record it. The approver is never the person who
   * asked. The gateway's own idempotency key is the refund's id, so a retry after a timeout cannot refund twice.
   */
  async approveRefund(orgId: string, id: string, by: string): Promise<{ status: string }> {
    const [r] = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM gateway_refunds WHERE org_id = ${orgId} AND id = ${id}`,
    );
    if (!r || !['requested', 'processing', 'failed'].includes(String(r['status'])))
      throw new PaymentsError('That refund is not waiting for a decision.', 'not_found');
    if (r['requested_by'] === by)
      throw new PaymentsError('Someone else has to approve a refund you asked for.', 'rule');
    const businessId = String(r['business_id']);
    const { row, gw } = await this.adapter(orgId, businessId);
    const [gp] = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM gateway_payments WHERE id = ${r['gateway_payment_id']}`,
    );
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE gateway_refunds SET status = 'processing', decided_by = ${by}, decided_at = ${this.now()}, updated_at = ${this.now()} WHERE id = ${id}`,
    );
    let res;
    try {
      res = await this.viaGateway(row, orgId, () =>
        gw.refund({
          paymentId: String(gp['provider_payment_id']),
          amountPaise: Number(r['amount_paise']),
          reference: id,
        }),
      );
    } catch (e) {
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE gateway_refunds SET status = 'failed', error = ${(e as Error).message.slice(0, 300)}, updated_at = ${this.now()} WHERE id = ${id}`,
      );
      throw e;
    }
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE gateway_refunds SET provider_refund_id = ${res.id}, updated_at = ${this.now()} WHERE id = ${id}`,
    );
    if (res.status === 'failed') {
      await this.failRefund(orgId, businessId, id, 'The gateway refused the refund.');
      return { status: 'failed' };
    }
    await this.bookRefund(orgId, businessId, id);
    return { status: res.status === 'processed' ? 'processed' : 'processing' };
  }

  /** Books the refund once: a payment made against the credit note, and the party's credit used up. */
  private async bookRefund(orgId: string, businessId: string, id: string): Promise<void> {
    const [r] = await this.org(orgId, (tx) => tx`SELECT * FROM gateway_refunds WHERE id = ${id}`);
    if (!r || r['payment_id']) return;
    const out = await new PaymentFlowRepo(this.o.db).recordRefund(this.ctx(orgId, businessId), {
      creditNoteId: String(r['credit_note_id']),
      date: istDate(this.now()),
      amountPaise: BigInt(r['amount_paise']),
      reference: String(r['provider_refund_id'] ?? id),
    });
    await this.org(orgId, async (tx) => {
      await tx`UPDATE gateway_refunds SET payment_id = ${out.payment['id']}, status = 'processed', updated_at = ${this.now()} WHERE id = ${id}`;
      await tx`UPDATE gateway_payments SET refunded_paise = refunded_paise + ${r['amount_paise']} WHERE id = ${r['gateway_payment_id']}`;
    });
  }

  private async failRefund(
    orgId: string,
    businessId: string,
    id: string,
    why: string,
  ): Promise<void> {
    const [r] = await this.org(orgId, async (tx) => {
      await tx`UPDATE gateway_refunds SET status = 'failed', error = ${why}, updated_at = ${this.now()} WHERE id = ${id}`;
      return tx`SELECT * FROM gateway_refunds WHERE id = ${id}`;
    });
    await this.attention(orgId, businessId, id, {
      reason: 'refund_failed',
      amountPaise: Number(r['amount_paise']),
      documentId: String(r['credit_note_id']),
      number: null,
      message: why,
      providerPaymentId: String(r['provider_refund_id'] ?? id),
    });
  }

  /** The gateway's later word on a refund (pending ones finish, or fail, by webhook). */
  private async applyRefund(
    orgId: string,
    businessId: string,
    ev: Extract<GatewayEvent, { type: 'refund' }>,
  ): Promise<boolean> {
    const [r]: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT id, status, payment_id FROM gateway_refunds WHERE org_id = ${orgId} AND provider_refund_id = ${ev.refundId}`,
    );
    if (!r) return false; // a refund made in the gateway's dashboard, not by us
    if (ev.status === 'failed') {
      if (r['status'] === 'failed') return false;
      await this.failRefund(
        orgId,
        businessId,
        String(r['id']),
        'The gateway could not pay the refund out.',
      );
      return true;
    }
    if (r['payment_id']) return false;
    await this.bookRefund(orgId, businessId, String(r['id']));
    return true;
  }
}
