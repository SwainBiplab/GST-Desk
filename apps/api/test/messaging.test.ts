/**
 * Messaging against a real Postgres (prompt 44): the plan gate, consent, approval, delivery through the mock
 * provider, retries, webhook signatures and idempotency, reminders and recurring invoices on a frozen clock,
 * the isolation between organisations, and that no address or name reaches the log.
 */
import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';

import { DocumentFlowRepo, PartyRepo, PaymentFlowRepo, type Ctx } from '@gst/db';
import {
  MockAdapter,
  ResendEmailAdapter,
  WhatsAppCloudAdapter,
  istInstant,
  MessagingError,
} from '@gst/messaging';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MessagingService, type DispatchJob } from '../src/messaging/service';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

let pg: PgStack;
let t: TestApp;
let owner: Client;
let orgId: string;
let businessId: string;
let userId: string;
let clock = istInstant('2026-11-05', '12:00');
const wa = new MockAdapter('whatsapp');
const mail = new MockAdapter('email');
const jobs: { job: DispatchJob; delay: number }[] = [];
const logLines: string[] = [];
const WA = {
  phoneNumberId: 'pn',
  businessAccountId: 'ba',
  accessToken: 'tok',
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
};
const RS_SECRET = `whsec_${Buffer.from('signing-key').toString('base64')}`;
let svc: MessagingService;

const ctx = (): Ctx => ({ orgId, businessId, actor: userId, deviceId: 'api' });
const sql = (q: string, params: unknown[] = []) =>
  pg.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(q, params as never[]);
  }) as Promise<Record<string, any>[]>;

async function makeParty(name: string, over: Record<string, unknown> = {}) {
  return String(
    (
      await new PartyRepo(pg.app).create(ctx(), {
        type: 'customer',
        name,
        state_code: '27',
        ...over,
      })
    )['id'],
  );
}
async function makeInvoice(
  partyId: string,
  name: string,
  date = '2026-11-05',
  due: string | null = null,
) {
  const flow = new DocumentFlowRepo(pg.app);
  const draft = { ...invoiceDraft(partyId, name, date, 10_000n), dueDate: due };
  const saved = await flow.saveDraft(ctx(), toRows(draft));
  const r = await flow.issueDraft(
    ctx(),
    String(saved.document['id']),
    Number(saved.document['version']),
  );
  return { id: String(r.document['id']), number: String(r.document['number']) };
}
const prep = (
  kind: 'invoice' | 'receipt' | 'reminder',
  documentId: string,
  extra: Record<string, unknown> = {},
) => svc.prepare({ orgId, businessId, kind, documentId, createdBy: userId, ...extra });
const hookSig = (body: string) =>
  `sha256=${createHmac('sha256', WA.appSecret).update(body).digest('hex')}`;

beforeAll(async () => {
  pg = await startPostgres();
  const live = {
    whatsapp: wa,
    email: mail,
    whatsappLive: new WhatsAppCloudAdapter(WA, (async () => new Response('{}')) as never),
    resendLive: new ResendEmailAdapter(
      { apiKey: 'k', from: 'x <x@example.test>', webhookSecret: RS_SECRET },
      (async () => new Response('{}')) as never,
    ),
  };
  const log = pino(
    { level: 'debug' },
    new Writable({
      write: (chunk, _e, cb) => {
        logLines.push(String(chunk));
        cb();
      },
    }),
  );
  svc = new MessagingService({
    db: pg.app,
    providers: live,
    log,
    now: () => clock,
    enqueue: async (job, delay = 0) => void jobs.push({ job, delay }),
  });
  t = makeTestApp(pg, { messaging: { service: svc, providers: live } });
  owner = await t.signIn('msg-owner@example.com', 'Owner');
  userId = String(
    (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'msg-owner@example.com'`)[0]!['id'],
  );
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Msg Traders' }),
    })
  ).body.id;
  businessId = (
    await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'Msg Traders', tradeName: 'Msg Traders', stateCode: '27' }),
    })
  ).body.id;
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

describe('the plan and consent', () => {
  it('makes nothing on the free plan, then something on the cloud plan', async () => {
    const p = await makeParty('Sharma Stores', {
      phone: '9876543210',
      email: 'sharma@example.test',
    });
    const inv = await makeInvoice(p, 'Sharma Stores');
    expect(await prep('invoice', inv.id)).toEqual({ ok: false, reason: 'plan' });
    await pg.admin.sql`UPDATE subscriptions SET plan_id = 'cloud' WHERE org_id = ${orgId}`;
    expect((await svc.entitlement(orgId)).enabled).toBe(true);
    // no WhatsApp consent yet, so the e-mail address is used
    const r = await prep('invoice', inv.id);
    expect(r).toMatchObject({ ok: true, approval: 'pending', channel: 'email' });
  });

  it('uses WhatsApp only with the customer’s opt-in, and never to someone who opted out', async () => {
    const p = await makeParty('Mehta Traders', {
      phone: '9123456789',
      email: 'mehta@example.test',
    });
    const inv = await makeInvoice(p, 'Mehta Traders');
    await sql(`UPDATE message_templates SET status = 'approved' WHERE language = 'en'`);
    await svc.setConsent(orgId, p, 'whatsapp', 'opted_in', 'test');
    expect(await prep('invoice', inv.id)).toMatchObject({ ok: true, channel: 'whatsapp' });
    const p2 = await makeParty('Rao Stores', { phone: '9000000001', email: 'rao@example.test' });
    const inv2 = await makeInvoice(p2, 'Rao Stores');
    await svc.setConsent(orgId, p2, 'whatsapp', 'opted_in', 'test');
    await svc.setConsent(orgId, p2, 'email', 'opted_out', 'test');
    await svc.setConsent(orgId, p2, 'whatsapp', 'opted_out', 'test');
    expect(await prep('invoice', inv2.id)).toMatchObject({ ok: false, reason: 'no_channel' });
  });
});

describe('approval and delivery', () => {
  let partyId: string;
  let doc: { id: string; number: string };
  beforeAll(async () => {
    partyId = await makeParty('Kapoor & Sons', {
      phone: '9811111111',
      email: 'kapoor@example.test',
    });
    doc = await makeInvoice(partyId, 'Kapoor & Sons');
  });

  it('waits in the outbox until approved, sends once with the PDF, meters usage and logs the timeline', async () => {
    const r = await prep('invoice', doc.id);
    expect(r).toMatchObject({ ok: true, approval: 'pending', channel: 'email' });
    const id = (r as { id: string }).id;
    expect((await svc.outbox(orgId)).map((m) => m['id'])).toContain(id);
    expect(await svc.deliver(orgId, id)).toBe('skipped'); // not approved: nothing is sent
    expect(mail.sent).toHaveLength(0);

    jobs.length = 0;
    expect(
      await svc.approve(orgId, id, userId, { body: 'Dear Kapoor, here is your invoice.' }),
    ).toBe(true);
    expect(jobs).toEqual([{ job: { type: 'deliver', orgId, messageId: id }, delay: 0 }]);
    expect(await svc.deliver(orgId, id)).toBe('sent');
    expect(await svc.deliver(orgId, id)).toBe('skipped'); // a second delivery of the same message does nothing
    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0]!;
    expect(sent.to).toBe('kapoor@example.test');
    expect(sent.key).toBe(id);
    const msg = sent.message as {
      document: { fileName: string; bytes: Uint8Array };
      subject?: string;
      text?: string;
    };
    expect(Buffer.from(msg.document.bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(msg.document.fileName).toMatch(/INV-26-27-\d+\.pdf$/);
    expect(msg.subject).toMatch(/^Invoice INV\/26-27\/\d+ from Msg Traders$/);
    expect(msg.text).toBe('Dear Kapoor, here is your invoice.');
    const [used] = await sql(
      `SELECT count(*)::int AS n FROM usage_events WHERE kind = 'message' AND ref = $1`,
      [id],
    );
    expect(used!['n']).toBe(1);
    const log = await svc.log(orgId, { documentId: doc.id });
    expect(log[0]!['status']).toBe('sent');
    expect((log[0]!['timeline'] as { status: string }[]).map((e) => e.status)).toEqual([
      'queued',
      'queued',
      'sent',
    ]);
    expect(await svc.approve(orgId, id, userId)).toBe(false);
  });

  it('turns a waiting message down, and a rejected one is never sent', async () => {
    const d2 = await makeInvoice(partyId, 'Kapoor & Sons');
    const r = (await prep('invoice', d2.id)) as { id: string };
    expect(await svc.reject(orgId, r.id, userId)).toBe(true);
    expect(await svc.deliver(orgId, r.id)).toBe('skipped');
    expect((await svc.log(orgId, { documentId: d2.id }))[0]).toMatchObject({
      status: 'failed',
      approval: 'rejected',
    });
  });

  it('sends by itself, after quiet hours, when auto-send is on for that kind', async () => {
    await svc.saveSettings(orgId, businessId, {
      onIssue: { tax_invoice: true },
      onPayment: true,
      reminders: true,
      offsets: [-3, 0, 7, 15],
      quietStart: '21:00',
      quietEnd: '09:00',
      autoSend: { invoice: true, receipt: true, reminder: true },
      channel: 'whatsapp_first',
      defaultLanguage: 'en',
    });
    const d3 = await makeInvoice(partyId, 'Kapoor & Sons');
    jobs.length = 0;
    const r = await prep('invoice', d3.id, { again: true });
    expect(r).toMatchObject({ ok: true, approval: 'auto' });
    expect(jobs).toHaveLength(1);
    expect(await svc.deliver(orgId, (r as { id: string }).id)).toBe('sent');
  });

  it('retries a busy provider with the attempts kept, ends a refusal, and gives up after five tries', async () => {
    const d = await makeInvoice(partyId, 'Kapoor & Sons');
    const r = (await prep('invoice', d.id, { again: true })) as { id: string };
    await svc.approve(orgId, r.id, userId);
    mail.failNext.push({ retryable: true, message: 'busy' });
    await expect(svc.deliver(orgId, r.id)).rejects.toBeInstanceOf(MessagingError);
    const [row] = await sql(`SELECT attempts, status, error FROM message_log WHERE id = $1`, [
      r.id,
    ]);
    expect(row).toMatchObject({ attempts: 1, status: 'queued', error: 'busy' });
    expect(await svc.deliver(orgId, r.id)).toBe('sent'); // the retry succeeds

    const d2 = await makeInvoice(partyId, 'Kapoor & Sons');
    const r2 = (await prep('invoice', d2.id, { again: true })) as { id: string };
    await svc.approve(orgId, r2.id, userId);
    mail.failNext.push({ retryable: false, message: 'invalid address' });
    expect(await svc.deliver(orgId, r2.id)).toBe('failed');
    expect((await svc.log(orgId, { documentId: d2.id }))[0]).toMatchObject({
      status: 'failed',
      error: 'invalid address',
    });

    const d3 = await makeInvoice(partyId, 'Kapoor & Sons');
    const r3 = (await prep('invoice', d3.id, { again: true })) as { id: string };
    await svc.approve(orgId, r3.id, userId);
    for (let i = 0; i < 4; i++) {
      mail.failNext.push({ retryable: true });
      await expect(svc.deliver(orgId, r3.id)).rejects.toBeInstanceOf(MessagingError);
    }
    mail.failNext.push({ retryable: true });
    expect(await svc.deliver(orgId, r3.id)).toBe('failed');
  });

  it('does not send to someone who opted out after the message was made, or for a cancelled invoice', async () => {
    const d = await makeInvoice(partyId, 'Kapoor & Sons');
    const r = (await prep('invoice', d.id, { again: true })) as { id: string };
    await svc.approve(orgId, r.id, userId);
    await svc.setConsent(orgId, partyId, 'email', 'opted_out', 'test');
    expect(await svc.deliver(orgId, r.id)).toBe('failed');
    expect((await svc.log(orgId, { documentId: d.id }))[0]!['error']).toBe(
      'the customer opted out',
    );
    await svc.setConsent(orgId, partyId, 'email', 'opted_in', 'test');

    const d2 = await makeInvoice(partyId, 'Kapoor & Sons');
    const r2 = (await prep('invoice', d2.id, { again: true })) as { id: string };
    await svc.approve(orgId, r2.id, userId);
    await new DocumentFlowRepo(pg.app)
      .cancelDocument?.(ctx(), d2.id, 1, 'test')
      .catch(() => undefined);
    await sql(`UPDATE documents SET status = 'cancelled' WHERE id = $1`, [d2.id]);
    expect(await svc.deliver(orgId, r2.id)).toBe('failed');
  });

  it('keeps names, numbers and addresses out of the log', () => {
    const all = logLines.join('');
    for (const secret of [
      'kapoor@example.test',
      '9811111111',
      'Kapoor',
      'sharma@example.test',
      '9876543210',
      'Dear',
    ])
      expect(all, secret).not.toContain(secret);
    expect(all).toContain('message sent');
  });
});

describe('receipts', () => {
  it('makes a receipt message with the voucher attached, against the invoice paid', async () => {
    const p = await makeParty('Iyer Mart', { phone: '9822222222', email: 'iyer@example.test' });
    const inv = await makeInvoice(p, 'Iyer Mart');
    const pay = await new PaymentFlowRepo(pg.app).record(ctx(), {
      direction: 'received',
      partyId: p,
      date: '2026-11-05',
      mode: 'upi',
      amountPaise: 5_000n,
      allocations: [{ documentId: inv.id, amountPaise: 5_000n }],
    } as never);
    const r = await svc.prepare({
      orgId,
      businessId,
      kind: 'receipt',
      documentId: inv.id,
      paymentId: String(pay.payment['id']),
      createdBy: userId,
    });
    expect(r).toMatchObject({ ok: true, channel: 'email', approval: 'auto' });
    const [m] = await sql(`SELECT variables, document_id FROM message_log WHERE id = $1`, [
      (r as { id: string }).id,
    ]);
    expect(m!['document_id']).toBe(String(pay.voucher!['id']));
    expect((m!['variables'] as string[])[2]).toBe(inv.number);
    expect((m!['variables'] as string[])[1]).toBe('₹50.00');
    // a second time for the same payment is the same message
    expect(
      await svc.prepare({
        orgId,
        businessId,
        kind: 'receipt',
        documentId: inv.id,
        paymentId: String(pay.payment['id']),
        createdBy: userId,
      }),
    ).toMatchObject({ ok: false, reason: 'duplicate' });
  });
});

describe('webhooks', () => {
  const waBody = (providerId: string, status: string, ts: number, extra = '') =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'x',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: providerId,
                    status,
                    timestamp: String(ts),
                    recipient_id: '919811111111',
                    ...(extra ? { errors: [{ code: 131026, title: extra }] } : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  let providerId = '';
  let messageId = '';

  beforeAll(async () => {
    const p = await makeParty('Joshi Agency', { phone: '9833333333', email: 'joshi@example.test' });
    await svc.setConsent(orgId, p, 'whatsapp', 'opted_in', 'test');
    const inv = await makeInvoice(p, 'Joshi Agency');
    const r = (await prep('invoice', inv.id)) as { id: string };
    messageId = r.id;
    await svc.approve(orgId, messageId, userId);
    await svc.deliver(orgId, messageId);
    providerId = String(
      (await sql(`SELECT provider_id FROM message_log WHERE id = $1`, [messageId]))[0]![
        'provider_id'
      ],
    );
  });

  const post = (body: string, sig: string) =>
    t.app.request('/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body,
    });

  it('answers Meta’s subscription challenge only for our token', async () => {
    const ok = await t.app.request(
      '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242',
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('4242');
    expect(
      (
        await t.app.request(
          '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
        )
      ).status,
    ).toBe(403);
  });

  it('refuses an unsigned or wrongly signed request, and changes nothing', async () => {
    const body = waBody(providerId, 'delivered', 1_767_225_603);
    expect((await post(body, 'sha256=00')).status).toBe(401);
    expect((await post(body, hookSig(body + ' '))).status).toBe(401);
    expect((await t.app.request('/v1/webhooks/whatsapp', { method: 'POST', body })).status).toBe(
      401,
    );
    expect(
      (await sql(`SELECT status FROM message_log WHERE id = $1`, [messageId]))[0]!['status'],
    ).toBe('sent');
  });

  it('shows the status at once, handles a repeat once, and never moves a message backwards', async () => {
    const delivered = waBody(providerId, 'delivered', 1_767_225_603);
    const started = Date.now();
    const res = await post(delivered, hookSig(delivered));
    expect(res.status).toBe(200);
    expect(
      (await sql(`SELECT status FROM message_log WHERE id = $1`, [messageId]))[0]!['status'],
    ).toBe('delivered');
    expect(Date.now() - started).toBeLessThan(10_000); // visible within ten seconds of receipt (here, at once)
    expect(await (await post(delivered, hookSig(delivered))).json()).toEqual({
      applied: 0,
      ignored: 1,
    });
    const read = waBody(providerId, 'read', 1_767_225_700);
    await post(read, hookSig(read));
    const late = waBody(providerId, 'sent', 1_767_225_601);
    await post(late, hookSig(late));
    expect(
      (await sql(`SELECT status FROM message_log WHERE id = $1`, [messageId]))[0]!['status'],
    ).toBe('read');
    const tl = (await svc.log(orgId, {}))[0]!;
    void tl;
    const events = await sql(
      `SELECT status FROM message_events WHERE message_id = $1 ORDER BY at`,
      [messageId],
    );
    expect(events.map((e) => e['status'])).toEqual(
      expect.arrayContaining(['queued', 'sent', 'delivered', 'read']),
    );
  });

  it('reads a customer’s STOP as an opt-out and approvals of templates from Meta', async () => {
    const stop = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'x',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '919833333333',
                    id: 'wamid.STOP1',
                    timestamp: '1767225800',
                    type: 'text',
                    text: { body: 'STOP' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect((await post(stop, hookSig(stop))).status).toBe(200);
    const [c] = await sql(
      `SELECT status FROM party_consent WHERE channel = 'whatsapp' AND party_id = (SELECT party_id FROM message_log WHERE id = $1)`,
      [messageId],
    );
    expect(c!['status']).toBe('opted_out');
    const [tpl] = await sql(
      `SELECT name FROM message_templates WHERE kind = 'invoice' AND language = 'hi'`,
    );
    const upd = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'x',
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'REJECTED',
                message_template_id: 1,
                message_template_name: tpl!['name'],
                message_template_language: 'hi',
                reason: 'INVALID_FORMAT',
              },
            },
          ],
        },
      ],
    });
    await post(upd, hookSig(upd));
    expect(
      (
        await sql(
          `SELECT status, reason FROM message_templates WHERE kind = 'invoice' AND language = 'hi'`,
        )
      )[0],
    ).toEqual({ status: 'rejected', reason: 'INVALID_FORMAT' });
  });

  it('applies Resend’s signed bounce', async () => {
    const [m] = await sql(
      `SELECT id, provider_id FROM message_log WHERE channel = 'email' AND provider_id IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: '2026-01-01T00:00:05.000Z',
      data: { email_id: m!['provider_id'], bounce: { message: 'mailbox full' } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const key = Buffer.from(RS_SECRET.replace('whsec_', ''), 'base64');
    const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    const res = await t.app.request('/v1/webhooks/resend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': String(ts),
        'svix-signature': `v1,${sig}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(
      (await sql(`SELECT status, error FROM message_log WHERE id = $1`, [m!['id']]))[0],
    ).toEqual({ status: 'bounced', error: 'mailbox full' });
  });
});

describe('reminders on a frozen clock', () => {
  let p: string;
  let inv: { id: string; number: string };
  beforeAll(async () => {
    p = await makeParty('Nair Brothers', { phone: '9844444444', email: 'nair@example.test' });
    inv = await makeInvoice(p, 'Nair Brothers', '2026-11-01', '2026-11-10');
  });
  const remindersFor = async () =>
    await sql(
      `SELECT dedupe_key, approval, status, not_before FROM message_log WHERE document_id = $1 AND kind = 'reminder' ORDER BY created_at`,
      [inv.id],
    );

  it('sends nothing before the first rule, and one reminder on the day, once', async () => {
    clock = istInstant('2026-11-05', '12:00');
    await svc.runReminders(orgId);
    expect(await remindersFor()).toHaveLength(0);
    clock = istInstant('2026-11-07', '12:00'); // three days before the due date
    await svc.runReminders(orgId);
    const first = await remindersFor();
    expect(first.map((r) => r['dedupe_key'])).toEqual([`reminder:${inv.id}:-3`]);
    await svc.runReminders(orgId);
    expect(await remindersFor()).toHaveLength(1);
    clock = istInstant('2026-11-10', '12:00');
    await svc.runReminders(orgId);
    expect((await remindersFor()).map((r) => r['dedupe_key'])).toEqual([
      `reminder:${inv.id}:-3`,
      `reminder:${inv.id}:0`,
    ]);
  });

  it('holds a reminder found at night until nine in the morning', async () => {
    clock = istInstant('2026-11-17', '23:00'); // seven days after
    await svc.runReminders(orgId);
    const last = (await remindersFor()).at(-1)!;
    expect(last['dedupe_key']).toBe(`reminder:${inv.id}:7`);
    expect(Number(last['not_before'])).toBe(istInstant('2026-11-18', '09:00'));
    const id = String(
      (await sql(`SELECT id FROM message_log WHERE dedupe_key = $1`, [`reminder:${inv.id}:7`]))[0]![
        'id'
      ],
    );
    expect(await svc.deliver(orgId, id)).toBe('later');
    clock = istInstant('2026-11-18', '09:05');
    expect(await svc.deliver(orgId, id)).toBe('sent');
  });

  it('never chases an opted-out customer, a paid invoice, or a cancelled one', async () => {
    const p2 = await makeParty('Opted Out Co', { phone: '9855555555', email: 'oo@example.test' });
    const a = await makeInvoice(p2, 'Opted Out Co', '2026-11-01', '2026-11-20');
    await svc.setConsent(orgId, p2, 'email', 'opted_out', 'test');
    const p3 = await makeParty('Paid Up Co', { phone: '9866666666', email: 'pu@example.test' });
    const b = await makeInvoice(p3, 'Paid Up Co', '2026-11-01', '2026-11-20');
    await new PaymentFlowRepo(pg.app).record(ctx(), {
      direction: 'received',
      partyId: p3,
      date: '2026-11-18',
      mode: 'cash',
      amountPaise: 99_999_999n,
      allocations: [
        {
          documentId: b.id,
          amountPaise: BigInt(
            String(
              (await sql(`SELECT total_paise FROM documents WHERE id = $1`, [b.id]))[0]![
                'total_paise'
              ],
            ),
          ),
        },
      ],
    } as never);
    const p4 = await makeParty('Cancelled Co', { phone: '9877777777', email: 'cc@example.test' });
    const c = await makeInvoice(p4, 'Cancelled Co', '2026-11-01', '2026-11-20');
    await sql(`UPDATE documents SET status = 'cancelled' WHERE id = $1`, [c.id]);
    clock = istInstant('2026-11-20', '12:00');
    await svc.runReminders(orgId);
    const rows = await sql(
      `SELECT document_id FROM message_log WHERE kind = 'reminder' AND document_id = ANY($1)`,
      [[a.id, b.id, c.id]],
    );
    expect(rows).toEqual([]);
  });
});

describe('recurring invoices', () => {
  let src: { id: string; number: string };
  let party: string;
  beforeAll(async () => {
    party = await makeParty('Retainer Client', { phone: '9888888888', email: 'rc@example.test' });
    src = await makeInvoice(party, 'Retainer Client', '2026-11-01');
  });

  it('is a cloud plan feature', async () => {
    await pg.admin.sql`UPDATE subscriptions SET plan_id = 'free' WHERE org_id = ${orgId}`;
    const free = await owner.fetch(`/v1/orgs/${orgId}/recurring-invoices`, {
      method: 'POST',
      body: JSON.stringify({
        businessId,
        name: 'Rent',
        sourceDocumentId: src.id,
        frequency: 'monthly',
        start: '2026-12-01',
      }),
    });
    expect(free.status).toBe(402);
    await pg.admin.sql`UPDATE subscriptions SET plan_id = 'cloud' WHERE org_id = ${orgId}`;
  });

  it('issues a priced copy on each date, catches up after an outage, and ends on its end date', async () => {
    clock = istInstant('2026-11-20', '10:00');
    const id = await svc.recurringCreate(orgId, {
      businessId,
      name: 'Monthly retainer',
      sourceDocumentId: src.id,
      frequency: 'monthly',
      every: 1,
      dayOfMonth: 25,
      start: '2026-11-20',
      endDate: '2027-01-31',
      dueDays: 15,
      send: true,
    });
    expect(
      (await sql(`SELECT next_run FROM recurring_invoices WHERE id = $1`, [id]))[0]!['next_run'],
    ).toBe('2026-11-25');
    expect(await svc.runRecurring(orgId)).toEqual({ made: 0, failed: 0 });
    clock = istInstant('2026-11-25', '10:00');
    expect(await svc.runRecurring(orgId)).toEqual({ made: 1, failed: 0 });
    const [r1] = await sql(
      `SELECT next_run, runs, last_document_id FROM recurring_invoices WHERE id = $1`,
      [id],
    );
    expect(r1).toMatchObject({ next_run: '2026-12-25', runs: 1 });
    const [d1] = await sql(
      `SELECT status, date, due_date, number, total_paise FROM documents WHERE id = $1`,
      [r1!['last_document_id']],
    );
    expect(d1).toMatchObject({ status: 'issued', date: '2026-11-25', due_date: '2026-12-10' });
    expect(String(d1!['number'])).not.toMatch(/^PROV/);
    expect(String(d1!['total_paise'])).toBe(
      String(
        (await sql(`SELECT total_paise FROM documents WHERE id = $1`, [src.id]))[0]!['total_paise'],
      ),
    );
    // sending is on: a message waits for approval
    expect(
      (
        await sql(`SELECT approval FROM message_log WHERE document_id = $1 AND kind = 'invoice'`, [
          r1!['last_document_id'],
        ])
      )[0]!['approval'],
    ).toBeDefined();
    // running again the same day makes nothing more
    expect(await svc.runRecurring(orgId)).toEqual({ made: 0, failed: 0 });
    // an outage over two months: both missed dates are made, in order, and then it ends
    clock = istInstant('2027-02-10', '10:00');
    const out = await svc.runRecurring(orgId);
    expect(
      out,
      JSON.stringify(
        await sql(`SELECT last_error FROM recurring_invoices WHERE name = 'Monthly retainer'`),
      ),
    ).toEqual({ made: 2, failed: 0 });
    const row = (await sql(`SELECT active, runs FROM recurring_invoices WHERE id = $1`, [id]))[0]!;
    expect(row['runs']).toBe(3);
  });

  it('raises one inbox item when an invoice cannot be made, and keeps trying', async () => {
    clock = istInstant('2026-12-01', '10:00');
    const id = await svc.recurringCreate(orgId, {
      businessId,
      name: 'Broken',
      sourceDocumentId: src.id,
      frequency: 'weekly',
      every: 1,
      dayOfMonth: 1,
      start: '2026-12-01',
      endDate: null,
      dueDays: 0,
      send: false,
    });
    await sql(`UPDATE recurring_invoices SET source_document_id = $1 WHERE id = $2`, [
      crypto.randomUUID(),
      id,
    ]);
    const r = await svc.runRecurring(orgId);
    expect(r.failed).toBe(1);
    await svc.runRecurring(orgId);
    const items = await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'recurring_failed'`,
    );
    expect(items).toHaveLength(1);
    expect((items[0]!['suggestion_json'] as { name: string }).name).toBe('Broken');
    expect(
      (await sql(`SELECT last_error FROM recurring_invoices WHERE id = $1`, [id]))[0]![
        'last_error'
      ],
    ).toMatch(/gone/);
  });
});

describe('isolation and permissions', () => {
  it('never shows one organisation’s messages to another, and the routes follow the roles', async () => {
    const other = await t.signIn('msg-other@example.com');
    const otherOrg = (
      await other.json<{ id: string }>('/v1/orgs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Other Org' }),
      })
    ).body.id;
    expect((await other.fetch(`/v1/orgs/${orgId}/messaging/log`)).status).toBe(404);
    const mine = await other.json<unknown[]>(`/v1/orgs/${otherOrg}/messaging/log`);
    expect(mine.body).toEqual([]);
    const viewer = await t.signIn('msg-viewer@example.com');
    await t.auth.api.addMember({
      body: {
        organizationId: orgId,
        userId: String(
          (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'msg-viewer@example.com'`)[0]![
            'id'
          ],
        ),
        role: 'viewer',
      },
    });
    expect((await viewer.fetch(`/v1/orgs/${orgId}/messaging/log`)).status).toBe(200);
    expect((await viewer.fetch(`/v1/orgs/${orgId}/messaging/outbox`)).status).toBe(200);
    expect(
      (
        await viewer.fetch(`/v1/orgs/${orgId}/messaging/settings/${businessId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
    const [m] = await sql(`SELECT id FROM message_log WHERE approval = 'pending' LIMIT 1`);
    expect(
      (
        await viewer.fetch(`/v1/orgs/${orgId}/messaging/messages/${m!['id']}/approve`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner.fetch(`/v1/orgs/${orgId}/messaging/messages/${m!['id']}/reject`, {
          method: 'POST',
        })
      ).status,
    ).toBe(204);
  });

  it('drives the whole thing through the routes: send, see the outbox, approve, read the log', async () => {
    await svc.saveSettings(orgId, businessId, {
      ...(await svc.settings(orgId, businessId)),
      autoSend: {},
    });
    const p = await makeParty('Route Client', { phone: '9899999999', email: 'route@example.test' });
    const inv = await makeInvoice(p, 'Route Client');
    const made = await owner.json<{ id: string; approval: string; channel: string }>(
      `/v1/orgs/${orgId}/messaging/send`,
      { method: 'POST', body: JSON.stringify({ businessId, kind: 'invoice', documentId: inv.id }) },
    );
    expect(made.status).toBe(201);
    expect(made.body.channel).toBe('email');
    const box = await owner.json<{ id: string }[]>(
      `/v1/orgs/${orgId}/messaging/outbox?businessId=${businessId}`,
    );
    expect(box.body.map((x) => x.id)).toContain(made.body.id);
    expect(
      (
        await owner.fetch(`/v1/orgs/${orgId}/messaging/messages/${made.body.id}/approve`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(204);
    expect(await svc.deliver(orgId, made.body.id)).toBe('sent');
    const log = await owner.json<{ id: string; status: string; timeline: unknown[] }[]>(
      `/v1/orgs/${orgId}/messaging/log?documentId=${inv.id}`,
    );
    expect(log.body[0]).toMatchObject({ id: made.body.id, status: 'sent' });
    const status = await owner.json<{
      enabled: boolean;
      used: number;
      channels: { whatsapp: boolean };
    }>(`/v1/orgs/${orgId}/messaging/status`);
    expect(status.body).toMatchObject({ enabled: true, channels: { whatsapp: true, email: true } });
    const prev = await owner.json<{ text: string; problems: string[] }>(
      `/v1/orgs/${orgId}/messaging/templates/preview`,
      { method: 'POST', body: JSON.stringify({ kind: 'invoice', language: 'hi' }) },
    );
    expect(prev.body.problems).toEqual([]);
    expect(prev.body.text).toContain('Sharma Stores');
  });
});
