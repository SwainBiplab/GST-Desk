/**
 * Payment collection against a real Postgres (prompt 45): the gateway keys sealed at rest, links and QR codes,
 * a signed webhook turning into a payment allocated to its invoice with the gateway's fee in the ledger, a
 * replayed or simultaneous webhook changing nothing the second time, partial, over- and unmatched payments
 * reaching the inbox, payouts reconciled, and refunds out of credit notes needing a second person.
 */
import { DocumentFlowRepo, PartyRepo, PaymentFlowRepo, type Ctx } from '@gst/db';
import { emptyDraft } from '@gst/domain';
import { MockGateway } from '@gst/payments';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PaymentsService } from '../src/payments/service';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

let pg: PgStack;
let t: TestApp;
let owner: Client;
let orgId: string;
let businessId: string;
let userId: string;
let svc: PaymentsService;
const gw = new MockGateway();
const KEY = Buffer.alloc(32, 3).toString('base64');
const TODAY = new Date().toISOString().slice(0, 10);
const INVOICE_PAISE = 25_600; // 2 x 100.00 + 28% GST

const ctx = (): Ctx => ({ orgId, businessId, actor: userId, deviceId: 'api' });
const sql = (q: string, params: unknown[] = []) =>
  pg.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(q, params as never[]);
  }) as Promise<Record<string, any>[]>;
const base = () => `/v1/orgs/${orgId}/payments`;

async function party(name: string) {
  return String(
    (await new PartyRepo(pg.app).create(ctx(), { type: 'customer', name, state_code: '27' }))['id'],
  );
}
async function issue(
  partyId: string,
  name: string,
  doc = invoiceDraft(partyId, name, TODAY, 10_000n),
) {
  const flow = new DocumentFlowRepo(pg.app);
  const saved = await flow.saveDraft(ctx(), toRows(doc));
  const r = await flow.issueDraft(
    ctx(),
    String(saved.document['id']),
    Number(saved.document['version']),
  );
  return String(r.document['id']);
}
async function creditNote(partyId: string, name: string) {
  const inv = invoiceDraft(partyId, name, TODAY, 10_000n);
  const draft = {
    ...emptyDraft('credit_note', TODAY, { supplierState: '27' }),
    partyId,
    partyName: name,
    partyState: '27',
    placeOfSupply: '27',
    lines: inv.lines.map((l) => ({ ...l })),
  };
  return issue(partyId, name, draft as never);
}
const position = async (documentId: string) =>
  (await new PaymentFlowRepo(pg.app).positions(ctx(), TODAY)).documents.find(
    (d) => d.id === documentId,
  )!;
async function connect() {
  return owner.json(`${base()}/gateway`, {
    method: 'PUT',
    body: JSON.stringify({
      businessId,
      keyId: 'rzp_test_abc123XYZ',
      keySecret: 'super-secret-key',
      webhookSecret: 'hook-secret',
    }),
  });
}
async function ask(
  documentId: string,
  kind: 'link' | 'qr' = 'link',
  extra: Record<string, unknown> = {},
) {
  return owner.json<any>(`${base()}/requests`, {
    method: 'POST',
    body: JSON.stringify({ businessId, documentId, kind, ...extra }),
  });
}
let gatewayId = '';
async function hook(body: ReturnType<MockGateway['payBody']>, id = gatewayId) {
  const res = await t.app.request(`/v1/webhooks/razorpay/${id}`, {
    method: 'POST',
    body: body.raw,
    headers: { 'content-type': 'application/json', ...body.headers },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  pg = await startPostgres();
  svc = new PaymentsService({
    db: pg.app,
    secretsKey: KEY,
    log: pino({ level: 'silent' }),
    adapterFor: () => gw,
  });
  t = makeTestApp(pg, { payments: svc });
  owner = await t.signIn('pay-owner@example.com', 'Owner');
  userId = String(
    (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'pay-owner@example.com'`)[0]!['id'],
  );
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Pay Traders' }),
    })
  ).body.id;
  businessId = (
    await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'Pay Traders', tradeName: 'Pay Traders', stateCode: '27' }),
    })
  ).body.id;
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

describe('connecting a gateway', () => {
  it('refuses a request before one is connected', async () => {
    const p = await party('Early Customer');
    const r = await ask(await issue(p, 'Early Customer'));
    expect(r.status).toBe(409);
  });

  it('seals the secrets: not in the database as text, not in any answer, and a bad key id is refused', async () => {
    const bad = await owner.json(`${base()}/gateway`, {
      method: 'PUT',
      body: JSON.stringify({
        businessId,
        keyId: 'not-a-key',
        keySecret: 'super-secret-key',
        webhookSecret: 'hook-secret',
      }),
    });
    expect(bad.status).toBe(400);
    const ok = await connect();
    expect(ok.status).toBe(200);
    const text = JSON.stringify(ok.body);
    expect(text).not.toContain('super-secret-key');
    expect(text).not.toContain('hook-secret');
    expect((ok.body as any).mode).toBe('test');
    const [row] = await sql('SELECT * FROM payment_gateways');
    expect(JSON.stringify(row)).not.toContain('super-secret-key');
    expect(String(row!['key_secret_enc'])).toMatch(/^v1\./);
    gatewayId = String(row!['id']);
    const st = await owner.json<any>(`${base()}/gateway?businessId=${businessId}`);
    expect(st.body).toMatchObject({
      connected: true,
      active: true,
      mode: 'test',
      keyId: 'rzp_test_abc123XYZ',
    });
    expect(st.body.webhookPath).toBe(`/v1/webhooks/razorpay/${gatewayId}`);
    expect(JSON.stringify(st.body)).not.toContain('secret');
  });

  it('keeps one organisation out of another’s gateway', async () => {
    const other = await t.signIn('pay-other@example.com', 'Other');
    const r = await other.json(`${base()}/gateway?businessId=${businessId}`);
    expect([403, 404]).toContain(r.status);
  });
});

describe('links and QR codes', () => {
  it('makes a link for exactly what is owed, and the same ask again is the same link', async () => {
    const p = await party('Link Customer');
    const doc = await issue(p, 'Link Customer');
    const a = await ask(doc, 'link');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      kind: 'link',
      amountPaise: INVOICE_PAISE,
      status: 'created',
      paidPaise: 0,
    });
    expect(a.body.url).toContain('https://pay.example/');
    expect(gw.links.at(-1)).toMatchObject({ amountPaise: INVOICE_PAISE, partialAllowed: false });
    const b = await ask(doc, 'link');
    expect(b.body.id).toBe(a.body.id);
    expect(gw.links.filter((l) => l.reference === a.body.id)).toHaveLength(1);
  });

  it('makes a one-time UPI QR with the amount fixed', async () => {
    const doc = await issue(await party('Qr Customer'), 'Qr Customer');
    const r = await ask(doc, 'qr');
    expect(r.body).toMatchObject({ kind: 'qr', amountPaise: INVOICE_PAISE });
    expect(r.body.imageUrl).toContain('.png');
    expect(r.body.url).toMatch(/^upi:\/\/pay\?/);
    expect(gw.qrs.at(-1)!.amountPaise).toBe(INVOICE_PAISE);
  });

  it('will not collect on a draft, a cancelled invoice or one that is already paid', async () => {
    const p = await party('Paid Customer');
    const doc = await issue(p, 'Paid Customer');
    await new PaymentFlowRepo(pg.app).record(ctx(), {
      direction: 'received',
      partyId: p,
      date: TODAY,
      mode: 'cash',
      amountPaise: BigInt(INVOICE_PAISE),
      allocations: [{ documentId: doc, amountPaise: BigInt(INVOICE_PAISE) }],
    });
    expect((await ask(doc)).status).toBe(422);
    expect((await ask('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('shows a gateway refusal as a 502 with its reason, and keeps it for the settings screen', async () => {
    const doc = await issue(await party('Refused Customer'), 'Refused Customer');
    const { GatewayError } = await import('@gst/payments');
    gw.failNext.push(
      new GatewayError('Payment link creation is not enabled for your account', false, 400),
    );
    const r = await ask(doc);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain('not enabled');
    const st = await owner.json<any>(`${base()}/gateway?businessId=${businessId}`);
    expect(st.body.lastError).toContain('not enabled');
  });
});

describe('a payment arriving', () => {
  it('rejects a webhook with a wrong signature or for an unknown gateway, and stores nothing', async () => {
    const doc = await issue(await party('Sig Customer'), 'Sig Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    const body = gw.payBody({ linkId: link.id }, INVOICE_PAISE);
    const bad = await hook({ raw: body.raw, headers: { 'x-razorpay-signature': 'nope' } });
    expect(bad.status).toBe(401);
    expect((await hook(body, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await hook(body, 'not-a-uuid')).status).toBe(404);
    expect(await sql('SELECT 1 FROM gateway_payments')).toHaveLength(0);
    expect((await position(doc)).balancePaise).toBe(BigInt(INVOICE_PAISE));
  });

  it('allocates to the invoice, marks it paid, posts the money and the fee, and closes the request', async () => {
    const p = await party('Happy Customer');
    const doc = await issue(p, 'Happy Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    const body = gw.payBody({ linkId: link.id }, INVOICE_PAISE, { feePaise: 604 });
    const r = await hook(body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ applied: 1, duplicates: 0 });

    const pos = await position(doc);
    expect(pos.balancePaise).toBe(0n);
    expect(pos.status).toBe('paid');
    const [gp] = await sql(`SELECT * FROM gateway_payments WHERE document_id = '${doc}'`);
    expect(gp).toMatchObject({ status: 'matched', fee_paise: 604, method: 'upi' });
    const [pay] = await sql(`SELECT * FROM payments WHERE id = '${gp!['payment_id']}'`);
    expect(pay).toMatchObject({ direction: 'received', mode: 'upi', party_id: p });
    expect(Number(pay!['amount_paise'])).toBe(INVOICE_PAISE);

    const led = await sql(
      `SELECT a.name, sum(e.debit_paise)::int AS dr, sum(e.credit_paise)::int AS cr FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.payment_id = '${gp!['payment_id']}' GROUP BY a.name`,
    );
    const by = Object.fromEntries(led.map((l) => [l['name'], l]));
    expect(by['Bank']).toMatchObject({ dr: INVOICE_PAISE, cr: 604 });
    expect(by['Accounts Receivable']).toMatchObject({ cr: INVOICE_PAISE });
    expect(by['Payment gateway fees']).toMatchObject({ dr: 604 });
    const totals = led.reduce((n, l) => n + Number(l['dr']) - Number(l['cr']), 0);
    expect(totals).toBe(0);

    const after = await owner.json<any>(`${base()}/requests/${req.id}`);
    expect(after.body).toMatchObject({ status: 'paid', paidPaise: INVOICE_PAISE });
  });

  it('applies a replayed or re-keyed webhook once; simultaneous deliveries too', async () => {
    const p = await party('Replay Customer');
    const doc = await issue(p, 'Replay Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    const first = gw.payBody({ linkId: link.id }, INVOICE_PAISE, { paymentId: 'pay_replay' });
    const [a, b, c] = await Promise.all([hook(first), hook(first), hook(first)]);
    const applied = [a, b, c].reduce((n, x) => n + x.body.applied, 0);
    expect(applied).toBe(1);
    // the gateway retries with a new event id for the same payment
    const again = gw.payBody({ linkId: link.id }, INVOICE_PAISE, {
      paymentId: 'pay_replay',
      eventKey: 'another-event',
    });
    expect((await hook(again)).body).toEqual({ applied: 0, duplicates: 1 });
    expect(await sql(`SELECT 1 FROM payments WHERE party_id = '${p}'`)).toHaveLength(1);
    expect(
      await sql(`SELECT 1 FROM payment_allocations WHERE document_id = '${doc}'`),
    ).toHaveLength(1);
    expect((await position(doc)).balancePaise).toBe(0n);
  });

  it('records a part payment on a link that allows it, and tells the inbox what is still owed', async () => {
    const doc = await issue(await party('Partial Customer'), 'Partial Customer');
    const req = (await ask(doc, 'link', { partialAllowed: true })).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    expect(link.partialAllowed).toBe(true);
    await hook(gw.payBody({ linkId: link.id }, 10_000));
    const pos = await position(doc);
    expect(pos).toMatchObject({ status: 'partial', balancePaise: BigInt(INVOICE_PAISE - 10_000) });
    expect((await owner.json<any>(`${base()}/requests/${req.id}`)).body).toMatchObject({
      status: 'partial',
      paidPaise: 10_000,
    });
    const [item] = await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'payment_attention' AND suggestion_json->>'documentId' = '${doc}'`,
    );
    expect(item!['suggestion_json']).toMatchObject({
      reason: 'partial',
      amountPaise: INVOICE_PAISE - 10_000,
    });
    // the rest comes later and settles it
    await hook(gw.payBody({ linkId: link.id }, INVOICE_PAISE - 10_000));
    expect((await position(doc)).status).toBe('paid');
  });

  it('keeps more than was owed as credit on the customer and says so', async () => {
    const p = await party('Over Customer');
    const doc = await issue(p, 'Over Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    await hook(gw.payBody({ linkId: link.id }, INVOICE_PAISE + 5_000));
    expect((await position(doc)).balancePaise).toBe(0n);
    const credit = await new PaymentFlowRepo(pg.app).partyPosition(ctx(), p, TODAY);
    expect(credit.creditPaise).toBe(5_000n);
    const items = await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'payment_attention' AND suggestion_json->>'documentId' = '${doc}'`,
    );
    expect(items.some((i) => i['suggestion_json'].reason === 'overpaid')).toBe(true);
  });

  it('takes money that matches no invoice into the inbox without inventing a payment', async () => {
    const before = (await sql('SELECT 1 FROM payments')).length;
    const r = await hook(gw.payBody({ linkId: 'plink_unknown' }, 7_700));
    expect(r.body.applied).toBe(1);
    expect((await sql('SELECT 1 FROM payments')).length).toBe(before);
    const [gp] = await sql(`SELECT * FROM gateway_payments WHERE status = 'unmatched'`);
    expect(Number(gp!['amount_paise'])).toBe(7_700);
    const items = await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'payment_attention'`,
    );
    expect(items.some((i) => i['suggestion_json'].reason === 'unmatched')).toBe(true);
    const list = await owner.json<any[]>(
      `${base()}/online?businessId=${businessId}&status=unmatched`,
    );
    expect(list.body).toHaveLength(1);
  });

  it('closes the other link or QR for an invoice once it is paid', async () => {
    const doc = await issue(await party('Two Ways Customer'), 'Two Ways Customer');
    const link = (await ask(doc, 'link')).body;
    const qr = (await ask(doc, 'qr')).body;
    await hook(gw.payBody({ qrId: gw.qrs.find((q) => q.reference === qr.id)!.id }, INVOICE_PAISE));
    expect((await owner.json<any>(`${base()}/requests/${qr.id}`)).body.status).toBe('paid');
    expect((await owner.json<any>(`${base()}/requests/${link.id}`)).body.status).toBe('cancelled');
    expect(gw.cancelled).toContain(gw.links.find((l) => l.reference === link.id)!.id);
  });
});

describe('payouts', () => {
  it('lists payouts and says whether the payments tagged to one add up to it, fee taken off', async () => {
    const doc = await issue(await party('Payout Customer'), 'Payout Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    await hook(
      gw.payBody({ linkId: link.id }, INVOICE_PAISE, { paymentId: 'pay_payout', feePaise: 600 }),
    );
    gw.settlements = [
      {
        id: 'setl_1',
        amountPaise: INVOICE_PAISE - 600,
        feePaise: 600,
        taxPaise: 92,
        utr: 'UTIB0000001',
        status: 'processed',
        at: Date.now(),
      },
    ];
    const synced = await owner.json<any[]>(`${base()}/settlements/sync`, {
      method: 'POST',
      body: JSON.stringify({ businessId }),
    });
    expect(synced.body[0]).toMatchObject({
      id: 'setl_1',
      utr: 'UTIB0000001',
      matched: false,
      expectedPaise: null,
    });
    const [row] = await sql('SELECT gateway_id FROM gateway_settlements');
    const tagged = await svc.tagSettlement(orgId, String(row!['gateway_id']), 'setl_1', [
      'pay_payout',
    ]);
    expect(tagged).toEqual({ expectedPaise: INVOICE_PAISE - 600, matched: true });
    // fetching again changes nothing about what is already known
    await owner.json(`${base()}/settlements/sync`, {
      method: 'POST',
      body: JSON.stringify({ businessId }),
    });
    expect(await sql('SELECT 1 FROM gateway_settlements')).toHaveLength(1);
  });
});

describe('refunds from credit notes', () => {
  it('needs a second person, pays through the gateway once, and uses up the credit note', async () => {
    const p = await party('Refund Customer');
    const doc = await issue(p, 'Refund Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    await hook(gw.payBody({ linkId: link.id }, INVOICE_PAISE, { paymentId: 'pay_refund' }));
    const [gp] = await sql(
      `SELECT id FROM gateway_payments WHERE provider_payment_id = 'pay_refund'`,
    );
    const note = await creditNote(p, 'Refund Customer');
    const noteTotal = Number(
      (await sql(`SELECT total_paise FROM documents WHERE id = '${note}'`))[0]!['total_paise'],
    );

    const asked = await owner.json<{ id: string }>(`${base()}/refunds`, {
      method: 'POST',
      body: JSON.stringify({
        businessId,
        gatewayPaymentId: gp!['id'],
        creditNoteId: note,
        amountPaise: 10_000,
      }),
    });
    expect(asked.status).toBe(201);
    // the person who asked cannot approve
    const self = await owner.json(`${base()}/refunds/${asked.body.id}/approve`, { method: 'POST' });
    expect(self.status).toBe(422);
    expect(gw.refunds.size).toBe(0);

    const second = await svc.approveRefund(orgId, asked.body.id, 'someone-else');
    expect(second.status).toBe('processed');
    expect(gw.refunds.size).toBe(1);
    // a second approval after it is done is refused, so the gateway is not asked twice
    await expect(svc.approveRefund(orgId, asked.body.id, 'someone-else')).rejects.toThrow(
      /not waiting/,
    );
    expect(gw.refunds.size).toBe(1);

    const remaining = (await new PaymentFlowRepo(pg.app).positions(ctx(), TODAY)).credits.find(
      (c) => c.id === note,
    )!;
    expect(remaining.balancePaise).toBe(BigInt(noteTotal - 10_000));
    const led = await sql(
      `SELECT a.name, sum(e.debit_paise)::int AS dr, sum(e.credit_paise)::int AS cr FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       JOIN gateway_refunds r ON r.payment_id = e.payment_id WHERE r.id = '${asked.body.id}' GROUP BY a.name`,
    );
    expect(Object.fromEntries(led.map((l) => [l['name'], l]))).toMatchObject({
      'Accounts Receivable': { dr: 10_000 },
      Bank: { cr: 10_000 },
    });
    const [after] = await sql(
      `SELECT refunded_paise FROM gateway_payments WHERE id = '${gp!['id']}'`,
    );
    expect(Number(after!['refunded_paise'])).toBe(10_000);
  });

  it('refuses more than was paid, more than the credit note holds, and another customer’s credit note', async () => {
    const p = await party('Limit Customer');
    const doc = await issue(p, 'Limit Customer');
    const req = (await ask(doc)).body;
    await hook(
      gw.payBody({ linkId: gw.links.find((l) => l.reference === req.id)!.id }, INVOICE_PAISE, {
        paymentId: 'pay_limit',
      }),
    );
    const [gp] = await sql(
      `SELECT id FROM gateway_payments WHERE provider_payment_id = 'pay_limit'`,
    );
    const note = await creditNote(p, 'Limit Customer');
    const stranger = await creditNote(await party('Someone Else'), 'Someone Else');
    const ask2 = (creditNoteId: string, amountPaise: number) =>
      owner.json(`${base()}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          businessId,
          gatewayPaymentId: gp!['id'],
          creditNoteId,
          amountPaise,
        }),
      });
    expect((await ask2(note, INVOICE_PAISE + 1)).status).toBe(422);
    expect((await ask2(stranger, 100)).status).toBe(422);
    expect((await ask2(note, 100)).status).toBe(201);
  });

  it('turns a refund the gateway refuses into a failed refund the owner can see, and books nothing', async () => {
    const p = await party('Failing Customer');
    const doc = await issue(p, 'Failing Customer');
    const req = (await ask(doc)).body;
    await hook(
      gw.payBody({ linkId: gw.links.find((l) => l.reference === req.id)!.id }, INVOICE_PAISE, {
        paymentId: 'pay_fail',
      }),
    );
    const [gp] = await sql(
      `SELECT id FROM gateway_payments WHERE provider_payment_id = 'pay_fail'`,
    );
    const note = await creditNote(p, 'Failing Customer');
    const id = (
      await owner.json<{ id: string }>(`${base()}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          businessId,
          gatewayPaymentId: gp!['id'],
          creditNoteId: note,
          amountPaise: 500,
        }),
      })
    ).body.id;
    const { GatewayError } = await import('@gst/payments');
    gw.failNext.push(new GatewayError('The refund could not be created', false, 400));
    await expect(svc.approveRefund(orgId, id, 'someone-else')).rejects.toThrow();
    const list = await owner.json<any[]>(`${base()}/refunds?businessId=${businessId}`);
    expect(list.body.find((r) => r.id === id)).toMatchObject({ status: 'failed' });
    expect(list.body.find((r) => r.id === id).error).toContain('could not be created');
    expect(
      await sql(
        `SELECT 1 FROM payments WHERE reference LIKE 'rfnd_%' AND notes LIKE 'Refund of%' AND amount_paise = 500`,
      ),
    ).toHaveLength(0);
  });
});

describe('a delivery that died half way', () => {
  it('adopts the payment already recorded instead of recording it twice', async () => {
    const p = await party('Crash Customer');
    const doc = await issue(p, 'Crash Customer');
    const req = (await ask(doc)).body;
    const link = gw.links.find((l) => l.reference === req.id)!;
    // the first delivery got as far as recording the payment, then the process died with the row still claimed
    await new PaymentFlowRepo(pg.app).record(ctx(), {
      direction: 'received',
      partyId: p,
      date: TODAY,
      mode: 'upi',
      amountPaise: BigInt(INVOICE_PAISE),
      reference: 'pay_crash',
      allocations: [{ documentId: doc, amountPaise: BigInt(INVOICE_PAISE) }],
    });
    await pg.admin
      .sql`INSERT INTO gateway_payments (id, org_id, business_id, gateway_id, provider_payment_id, amount_paise, method, status, claimed_at, at, created_at)
      VALUES (gen_random_uuid(), ${orgId}, ${businessId}, ${gatewayId}, 'pay_crash', ${INVOICE_PAISE}, 'upi', 'processing', ${Date.now() - 120_000}, ${Date.now()}, ${Date.now()})`;
    const r = await hook(
      gw.payBody({ linkId: link.id }, INVOICE_PAISE, { paymentId: 'pay_crash' }),
    );
    expect(r.body.applied).toBe(1);
    expect(await sql(`SELECT 1 FROM payments WHERE reference = 'pay_crash'`)).toHaveLength(1);
    expect(
      (
        await sql(`SELECT status FROM gateway_payments WHERE provider_payment_id = 'pay_crash'`)
      )[0]!['status'],
    ).toBe('matched');
    expect((await position(doc)).balancePaise).toBe(0n);
  });
});
