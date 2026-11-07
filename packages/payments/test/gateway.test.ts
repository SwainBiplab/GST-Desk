import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GatewayError,
  MockGateway,
  RazorpayAdapter,
  hmacHex,
  openSecret,
  razorpayMode,
  sealSecret,
} from '../src';

import { scripted } from './helpers';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const KEY = Buffer.alloc(32, 7).toString('base64');
const make = (answers: Parameters<typeof scripted>[0]) => {
  const s = scripted(answers);
  return {
    s,
    a: new RazorpayAdapter({
      keyId: 'rzp_test_abc',
      keySecret: 'shh',
      webhookSecret: 'whsec',
      fetch: s.fn,
    }),
  };
};

describe('RazorpayAdapter requests', () => {
  it('creates a link in paise with our reference, no gateway notifications, and basic auth', async () => {
    const { a, s } = make([
      {
        match: (u) => u.endsWith('/payment_links'),
        json: JSON.parse(fx('payment_link.created.json')),
      },
    ]);
    const r = await a.createLink({
      reference: 'req-1',
      amountPaise: 118000,
      description: 'Invoice INV/26-27/0001',
      partialAllowed: false,
      expiresAt: 1_800_000_000_000,
    });
    expect(r).toEqual({
      providerRef: 'plink_Abc123',
      url: 'https://rzp.io/i/abc123',
      expiresAt: 1_800_000_000_000,
    });
    const sent = JSON.parse(String(s.calls[0]!.init.body));
    expect(sent).toMatchObject({
      amount: 118000,
      currency: 'INR',
      reference_id: 'req-1',
      expire_by: 1_800_000_000,
      notify: { sms: false, email: false },
    });
    expect((s.calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      `Basic ${Buffer.from('rzp_test_abc:shh').toString('base64')}`,
    );
  });

  it('creates a fixed-amount single-use UPI QR that closes at least three minutes ahead', async () => {
    const { a, s } = make([
      { match: (u) => u.endsWith('/payments/qr_codes'), json: JSON.parse(fx('qr.created.json')) },
    ]);
    const r = await a.createUpiQr({
      reference: 'req-2',
      amountPaise: 50000,
      description: 'x',
      expiresAt: Date.now(),
    });
    expect(r.providerRef).toBe('qr_Q1');
    expect(r.payload).toMatch(/^upi:\/\/pay\?/);
    const sent = JSON.parse(String(s.calls[0]!.init.body));
    expect(sent).toMatchObject({
      type: 'upi_qr',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: 50000,
    });
    expect(sent.close_by * 1000).toBeGreaterThan(Date.now() + 2 * 60_000);
  });

  it("turns an API refusal into a GatewayError carrying Razorpay's reason; 5xx and 429 are retryable", async () => {
    const bad = make([{ match: () => true, status: 400, json: JSON.parse(fx('error.json')) }]);
    await expect(bad.a.getPayment('pay_1')).rejects.toMatchObject({
      name: 'GatewayError',
      retryable: false,
      status: 400,
      message: expect.stringContaining('not enabled'),
    });
    for (const status of [429, 503]) {
      const m = make([{ match: () => true, status, json: {} }]);
      const e = await m.a.getPayment('p').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).retryable).toBe(true);
    }
  });

  it('refunds with an idempotency key', async () => {
    const { a, s } = make([
      {
        match: (u) => u.includes('/refund'),
        json: { id: 'rfnd_R1', status: 'processed', amount: 30000 },
      },
    ]);
    const r = await a.refund({ paymentId: 'pay_1', amountPaise: 30000, reference: 'ref-9' });
    expect(r).toEqual({ id: 'rfnd_R1', status: 'processed', amountPaise: 30000 });
    expect((s.calls[0]!.init.headers as Record<string, string>)['x-razorpay-idempotency']).toBe(
      'ref-9',
    );
  });

  it('reads settlements with fees, tax and UTR', async () => {
    const { a } = make([
      {
        match: (u) => u.includes('/settlements'),
        json: { items: [JSON.parse(fx('settlement.processed.json')).payload.settlement.entity] },
      },
    ]);
    const [s] = await a.listSettlements(0, 1_800_000_000_000);
    expect(s).toMatchObject({
      id: 'setl_S1',
      amountPaise: 112000,
      feePaise: 2784,
      taxPaise: 425,
      utr: 'UTIB1234567890',
      status: 'processed',
    });
  });

  it('knows test keys from live ones', () => {
    expect(razorpayMode('rzp_test_x')).toBe('test');
    expect(razorpayMode('rzp_live_x')).toBe('live');
  });
});

describe('RazorpayAdapter webhooks', () => {
  const a = make([]).a;
  const sign = (raw: string, secret = 'whsec') => ({
    'x-razorpay-signature': hmacHex(secret, raw),
    'x-razorpay-event-id': 'evt_1',
  });

  it('checks the signature over the raw body, and refuses a wrong secret, a missing header or an edited body', () => {
    const raw = fx('payment_link.paid.json');
    expect(a.verifyWebhook(sign(raw), raw)).toBe(true);
    expect(a.verifyWebhook(sign(raw, 'other'), raw)).toBe(false);
    expect(a.verifyWebhook({}, raw)).toBe(false);
    expect(a.verifyWebhook(sign(raw), raw.replace('118000', '1'))).toBe(false);
  });

  it('reads a paid link: the link id, our reference, the payment with its fee and GST', () => {
    const [e] = a.parseWebhook(fx('payment_link.paid.json'), sign(''));
    expect(e).toMatchObject({
      type: 'paid',
      eventKey: 'razorpay:evt_1',
      request: { linkId: 'plink_Abc123', reference: 'req-1' },
      payment: {
        id: 'pay_Xyz789',
        amountPaise: 118000,
        feePaise: 2784,
        taxPaise: 425,
        method: 'upi',
        status: 'captured',
      },
    });
  });

  it('reads a credited QR through the reference we put in its notes', () => {
    const [e] = a.parseWebhook(fx('qr_code.credited.json'));
    expect(e).toMatchObject({
      type: 'paid',
      request: { qrId: 'qr_Q1', reference: 'req-2' },
      payment: { id: 'pay_Q9', amountPaise: 50000 },
    });
    expect((e as { eventKey: string }).eventKey).toContain('qr_code.credited');
  });

  it('reads refunds and settlements, and ignores payment.captured (the link event carries that payment)', () => {
    expect(a.parseWebhook(fx('refund.processed.json'))[0]).toMatchObject({
      type: 'refund',
      paymentId: 'pay_Xyz789',
      refundId: 'rfnd_R1',
      amountPaise: 30000,
      status: 'processed',
    });
    expect(a.parseWebhook(fx('settlement.processed.json'))[0]).toMatchObject({
      type: 'settlement',
      settlement: { id: 'setl_S1', utr: 'UTIB1234567890' },
    });
    expect(a.parseWebhook(fx('payment.captured.json'))).toEqual([]);
  });
});

describe('sealed secrets', () => {
  it('round-trips, never stores the plain text, and does not open for another organisation or key', () => {
    const sealed = sealSecret('rzp-secret-value', KEY, 'org-1');
    expect(sealed).not.toContain('rzp-secret-value');
    expect(openSecret(sealed, KEY, 'org-1')).toBe('rzp-secret-value');
    expect(() => openSecret(sealed, KEY, 'org-2')).toThrow();
    expect(() => openSecret(sealed, Buffer.alloc(32, 9).toString('base64'), 'org-1')).toThrow();
    expect(sealSecret('rzp-secret-value', KEY, 'org-1')).not.toBe(sealed);
  });
  it('wants a 32-byte key', () => {
    expect(() => sealSecret('x', 'c2hvcnQ=', 'o')).toThrow(/32 bytes/);
  });
});

describe('MockGateway', () => {
  it('signs the webhook it produces and a refund with the same reference is one refund', async () => {
    const g = new MockGateway();
    const l = await g.createLink({
      reference: 'r',
      amountPaise: 1000,
      description: 'd',
      partialAllowed: false,
      expiresAt: 1,
    });
    const { raw, headers } = g.payBody({ linkId: l.providerRef }, 1000);
    expect(g.verifyWebhook(headers, raw)).toBe(true);
    expect(g.verifyWebhook({ ...headers, 'x-razorpay-signature': 'bad' }, raw)).toBe(false);
    const a = await g.refund({ paymentId: 'p', amountPaise: 10, reference: 'x' });
    expect(await g.refund({ paymentId: 'p', amountPaise: 10, reference: 'x' })).toEqual(a);
    expect(g.refunds.size).toBe(1);
  });
});
