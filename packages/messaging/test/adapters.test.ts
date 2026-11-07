import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MessagingError,
  ResendEmailAdapter,
  WhatsAppCloudAdapter,
  MockAdapter,
  advances,
} from '../src';

import { metaSignature, scripted, svixHeaders } from './helpers';

const fixture = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8');
const pdf = {
  fileName: 'INV-0001.pdf',
  mime: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-1.4 test'),
};

const wa = (fetchFn: ReturnType<typeof scripted>['fn']) =>
  new WhatsAppCloudAdapter(
    {
      phoneNumberId: '106540352242922',
      businessAccountId: '102290129340398',
      accessToken: 'tok',
      appSecret: 'app-secret',
      verifyToken: 'verify-me',
    },
    fetchFn,
  );

describe('WhatsApp Cloud adapter', () => {
  it('uploads the PDF, then sends a template with it as the header and the variables as the body', async () => {
    const s = scripted([
      { match: (u) => u.endsWith('/106540352242922/media'), json: { id: 'media-1' } },
      {
        match: (u) => u.endsWith('/106540352242922/messages'),
        json: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] },
      },
    ]);
    const r = await wa(s.fn).sendTemplate({
      to: '919876543210',
      template: 'gd_ab12cd34_invoice',
      language: 'en',
      variables: ['Sharma', 'INV/1', '₹700.00', 'Asha'],
      document: pdf,
      idempotencyKey: 'k1',
    });
    expect(r).toEqual({ providerId: 'wamid.ABC', status: 'sent' });
    expect(s.calls[0]!.init.body).toBeInstanceOf(FormData);
    const body = JSON.parse(String(s.calls[1]!.init.body));
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'gd_ab12cd34_invoice',
        language: { code: 'en' },
        components: [
          {
            type: 'header',
            parameters: [
              { type: 'document', document: { id: 'media-1', filename: 'INV-0001.pdf' } },
            ],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Sharma' },
              { type: 'text', text: 'INV/1' },
              { type: 'text', text: '₹700.00' },
              { type: 'text', text: 'Asha' },
            ],
          },
        ],
      },
    });
    expect((s.calls[1]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer tok',
    );
  });

  it('sends a plain document message inside a customer window', async () => {
    const s = scripted([
      { match: (u) => u.endsWith('/media'), json: { id: 'media-2' } },
      { match: (u) => u.endsWith('/messages'), json: { messages: [{ id: 'wamid.DOC' }] } },
    ]);
    await wa(s.fn).sendDocument({
      to: '919876543210',
      document: pdf,
      caption: 'Your invoice',
      idempotencyKey: 'k2',
    });
    expect(JSON.parse(String(s.calls[1]!.init.body))).toMatchObject({
      type: 'document',
      document: { id: 'media-2', filename: 'INV-0001.pdf', caption: 'Your invoice' },
    });
  });

  it('calls a busy provider retryable and a refusal permanent', async () => {
    const busy = scripted([
      { match: () => true, status: 429, json: { error: { message: 'rate limit', code: 80007 } } },
    ]);
    await expect(
      wa(busy.fn).sendTemplate({
        to: '1',
        template: 't',
        language: 'en',
        variables: [],
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ retryable: true, status: 429 });
    const refused = scripted([
      {
        match: () => true,
        status: 400,
        json: { error: { message: 'Template does not exist', code: 132001 } },
      },
    ]);
    const e = await wa(refused.fn)
      .sendTemplate({ to: '1', template: 't', language: 'en', variables: [], idempotencyKey: 'k' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MessagingError);
    expect(e).toMatchObject({ retryable: false, status: 400, code: '132001' });
    const down = async () => {
      throw new Error('socket hang up');
    };
    await expect(
      wa(down as never).sendTemplate({
        to: '1',
        template: 't',
        language: 'en',
        variables: [],
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('checks the webhook signature over the raw body and the subscription challenge', () => {
    const a = wa(scripted([]).fn);
    const body = fixture('whatsapp-webhook.json');
    expect(
      a.verifyWebhook({ 'x-hub-signature-256': metaSignature('app-secret', body) }, body),
    ).toBe(true);
    expect(a.verifyWebhook({ 'x-hub-signature-256': metaSignature('other', body) }, body)).toBe(
      false,
    );
    expect(
      a.verifyWebhook({ 'x-hub-signature-256': metaSignature('app-secret', body) }, body + ' '),
    ).toBe(false);
    expect(a.verifyWebhook({}, body)).toBe(false);
    expect(
      a.verifyChallenge({ mode: 'subscribe', token: 'verify-me', challenge: '1158201444' }),
    ).toBe('1158201444');
    expect(a.verifyChallenge({ mode: 'subscribe', token: 'nope', challenge: '1' })).toBeNull();
  });

  it('turns Meta’s delivery webhook into status events, with the reason of a failure', () => {
    const e = wa(scripted([]).fn).parseWebhook(fixture('whatsapp-webhook.json'));
    expect(e.statuses.map((s) => [s.status, s.at])).toEqual([
      ['sent', 1767225601000],
      ['delivered', 1767225603000],
      ['failed', 1767225604000],
    ]);
    expect(e.statuses[2]!.error).toBe('131026 Message undeliverable');
    expect(new Set(e.statuses.map((s) => s.eventId)).size).toBe(3);
  });

  it('reads STOP as an opt-out, and mirrors template approvals', () => {
    const a = wa(scripted([]).fn);
    expect(a.parseWebhook(fixture('whatsapp-inbound-stop.json')).consents).toEqual([
      expect.objectContaining({ from: '919876543210', status: 'opted_out' }),
    ]);
    const t = a.parseWebhook(fixture('whatsapp-template-status.json')).templates;
    expect(t.map((x) => [x.language, x.status, x.reason])).toEqual([
      ['hi', 'rejected', 'INVALID_FORMAT'],
      ['en', 'approved', undefined],
    ]);
    expect(a.parseWebhook('not json')).toEqual({ statuses: [], consents: [], templates: [] });
  });

  it('lists and submits templates', async () => {
    const s = scripted([
      {
        match: (u, i) => u.includes('/102290129340398/message_templates') && i.method === 'GET',
        json: {
          data: [
            { id: '1', name: 'gd_ab12cd34_invoice', language: 'en', status: 'APPROVED' },
            {
              id: '2',
              name: 'gd_ab12cd34_invoice',
              language: 'hi',
              status: 'REJECTED',
              rejected_reason: 'INVALID_FORMAT',
            },
          ],
        },
      },
      {
        match: (u, i) => u.endsWith('/102290129340398/message_templates') && i.method === 'POST',
        json: { id: '3', status: 'PENDING' },
      },
    ]);
    const a = wa(s.fn);
    expect((await a.listTemplates()).map((t) => [t.language, t.status])).toEqual([
      ['en', 'approved'],
      ['hi', 'rejected'],
    ]);
    expect(
      await a.submitTemplate({
        name: 'gd_ab12cd34_invoice',
        language: 'ta',
        body: 'x {{1}} y',
        examples: ['A'],
        documentHeader: true,
      }),
    ).toEqual({ id: '3', status: 'pending' });
    const sent = JSON.parse(String(s.calls[1]!.init.body));
    expect(sent.category).toBe('UTILITY');
    expect(sent.components[0]).toMatchObject({ type: 'HEADER', format: 'DOCUMENT' });
  });
});

describe('Resend email adapter', () => {
  const secret = 'whsec_' + Buffer.from('signing-key-bytes').toString('base64');
  const email = (fetchFn: ReturnType<typeof scripted>['fn']) =>
    new ResendEmailAdapter(
      { apiKey: 're_key', from: 'GST Desk <billing@example.test>', webhookSecret: secret },
      fetchFn,
    );

  it('sends the PDF as a base64 attachment with an idempotency key', async () => {
    const s = scripted([
      { match: (u) => u.endsWith('/emails'), json: { id: '56761188-7520-42d8-8898-ff6fc54ce618' } },
    ]);
    const r = await email(s.fn).sendTemplate({
      to: 'customer@example.test',
      template: 'invoice',
      language: 'en',
      variables: [],
      subject: 'Invoice INV/1',
      text: 'Dear Sharma',
      document: pdf,
      idempotencyKey: 'msg-1',
    });
    expect(r.providerId).toBe('56761188-7520-42d8-8898-ff6fc54ce618');
    const h = s.calls[0]!.init.headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('msg-1');
    expect(h['authorization']).toBe('Bearer re_key');
    const body = JSON.parse(String(s.calls[0]!.init.body));
    expect(body).toMatchObject({
      from: 'GST Desk <billing@example.test>',
      to: ['customer@example.test'],
      subject: 'Invoice INV/1',
    });
    expect(Buffer.from(body.attachments[0].content, 'base64').toString()).toBe('%PDF-1.4 test');
  });

  it('asks for the status of an email and calls errors by whether they repeat', async () => {
    const s = scripted([
      { match: (u) => u.includes('/emails/abc'), json: { id: 'abc', last_event: 'delivered' } },
    ]);
    expect(await email(s.fn).getStatus('abc')).toBe('delivered');
    const down = scripted([
      { match: () => true, status: 503, json: { name: 'application_error', message: 'try later' } },
    ]);
    await expect(
      email(down.fn).sendDocument({
        to: 'a@b.test',
        document: pdf,
        caption: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ retryable: true });
    const bad = scripted([
      {
        match: () => true,
        status: 422,
        json: { name: 'validation_error', message: 'Invalid `to` field' },
      },
    ]);
    await expect(
      email(bad.fn).sendDocument({ to: 'nope', document: pdf, caption: 'x', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ retryable: false, status: 422 });
  });

  it('verifies the Svix signature, refuses a stale timestamp and a changed body, and parses a bounce', () => {
    const a = email(scripted([]).fn);
    const body = fixture('resend-webhook-bounced.json');
    const now = 1_767_225_605_000;
    const h = svixHeaders(secret, 'msg_2abc', Math.floor(now / 1000), body);
    expect(a.verifyWebhook(h, body, now)).toBe(true);
    expect(a.verifyWebhook(h, body + 'x', now)).toBe(false);
    expect(a.verifyWebhook(h, body, now + 10 * 60_000)).toBe(false);
    expect(a.verifyWebhook({ ...h, 'svix-signature': 'v1,AAAA' }, body, now)).toBe(false);
    expect(a.verifyWebhook({}, body, now)).toBe(false);
    const e = a.parseWebhook(body, h);
    expect(e.statuses).toEqual([
      expect.objectContaining({
        providerId: '56761188-7520-42d8-8898-ff6fc54ce618',
        status: 'bounced',
        eventId: 'rs:56761188-7520-42d8-8898-ff6fc54ce618:email.bounced:msg_2abc',
      }),
    ]);
    expect(e.statuses[0]!.error).toMatch(/suppression list/);
  });
});

describe('status order and the mock', () => {
  it('only moves a message forward, and a late failure does not undo a delivery', () => {
    expect(advances('sent', 'delivered')).toBe(true);
    expect(advances('delivered', 'sent')).toBe(false);
    expect(advances('read', 'delivered')).toBe(false);
    expect(advances('queued', 'failed')).toBe(true);
    expect(advances('delivered', 'failed')).toBe(false);
    expect(advances('failed', 'delivered')).toBe(false);
    expect(advances('delivered', 'read')).toBe(true);
  });

  it('answers a repeated send with the first, and can be told to fail', async () => {
    const m = new MockAdapter('email');
    const a = await m.sendTemplate({
      to: 'x',
      template: 't',
      language: 'en',
      variables: [],
      idempotencyKey: 'same',
    });
    const b = await m.sendTemplate({
      to: 'x',
      template: 't',
      language: 'en',
      variables: [],
      idempotencyKey: 'same',
    });
    expect(b).toEqual(a);
    expect(m.sent).toHaveLength(1);
    m.failNext.push({ retryable: true });
    await expect(
      m.sendTemplate({
        to: 'x',
        template: 't',
        language: 'en',
        variables: [],
        idempotencyKey: 'other',
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});
