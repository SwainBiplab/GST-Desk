import { buildEinvoice, gstinCheckChar, type EinvDoc } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import {
  GspClient,
  GspError,
  MockGspAdapter,
  REMOVED,
  VendorXAdapter,
  WrongPinError,
  openCredentials,
  pinProblem,
  redact,
  sealCredentials,
  type GspCredentials,
  type GspLogEntry,
} from '../src';

const g = (first14: string) => first14 + gstinCheckChar(first14);
const SELLER = g('27AAPFU0939F1Z');
const BUYER = g('29AABCU9603R1Z');

const creds: GspCredentials = {
  gstin: SELLER,
  einvUser: 'demo_api',
  einvPassword: 'S3cret!pass',
  ewbUser: 'demo_ewb',
  ewbPassword: 'An0ther!pass',
};

const doc: EinvDoc = {
  kind: 'INV',
  number: 'INV/24-25/0042',
  date: '2025-05-01',
  supply: 'B2B',
  reverseCharge: false,
  seller: {
    gstin: SELLER,
    legalName: 'Demo Traders',
    addr1: '12 MG Road',
    location: 'Pune',
    pincode: '411001',
    stateCode: '27',
  },
  buyer: {
    gstin: BUYER,
    legalName: 'Acme Retail',
    addr1: '5 Brigade Road',
    location: 'Bengaluru',
    pincode: '560001',
    stateCode: '29',
    pos: '29',
  },
  lines: [
    {
      description: 'Steel flask',
      hsn: '732393',
      qtyMicros: 2_000_000,
      uqc: 'NOS',
      unitPricePaise: 50_000,
      grossPaise: 100_000,
      discountPaise: 0,
      taxablePaise: 100_000,
      gstRateBp: 1800,
      igstPaise: 18_000,
      cgstPaise: 0,
      sgstPaise: 0,
      cessRateBp: 0,
      cessPaise: 0,
      otherChargesPaise: 0,
      totalPaise: 118_000,
    },
  ],
  totals: {
    assessablePaise: 100_000,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 18_000,
    cessPaise: 0,
    discountPaise: 0,
    otherChargesPaise: 0,
    roundOffPaise: 0,
    totalPaise: 118_000,
  },
};
const payload = buildEinvoice(doc);
const ref = { type: 'INV', number: doc.number, date: doc.date };

function setup(start = '2025-05-01T10:00:00+05:30') {
  let now = new Date(start);
  const mock = new MockGspAdapter({ now: () => now });
  const log: GspLogEntry[] = [];
  let unlocked: GspCredentials | null = creds;
  const client = new GspClient(mock, {
    credentials: () => unlocked,
    log: (e) => void log.push(e),
    now: () => now.getTime(),
  });
  return {
    mock,
    client,
    log,
    advance: (hours: number) => (now = new Date(now.getTime() + hours * 3_600_000)),
    lock: () => (unlocked = null),
  };
}

describe('e-invoice through the practice GSP', () => {
  it('generates an IRN with an acknowledgement and a signed QR, and logs in once', async () => {
    const { client, log } = setup();
    const r = await client.generateIrn(payload, ref);
    expect(r.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ackNo).toMatch(/^\d{15}$/);
    expect(r.ackDate).toBe('2025-05-01 10:00:00');
    expect(r.recovered).toBe(false);
    const qr = JSON.parse(
      JSON.parse(atob(r.signedQr.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))['data'],
    );
    expect(qr).toMatchObject({
      SellerGstin: SELLER,
      BuyerGstin: BUYER,
      DocNo: doc.number,
      Irn: r.irn,
      TotInvVal: 1180,
      ItemCnt: 1,
      MainHsnCode: '732393',
    });
    await client.generateIrn(buildEinvoice({ ...doc, number: 'INV/24-25/0043' }), {
      ...ref,
      number: 'INV/24-25/0043',
    });
    expect(log.filter((e) => e.action === 'authenticate')).toHaveLength(1);
  });

  it('treats a second request for the same document as the IRN it already has', async () => {
    const { client } = setup();
    const first = await client.generateIrn(payload, ref);
    const again = await client.generateIrn(payload, ref);
    expect(again).toMatchObject({ irn: first.irn, ackNo: first.ackNo, recovered: true });
  });

  it('remembers what it issued across a reload when given its saved state', async () => {
    const { client, mock } = setup();
    const first = await client.generateIrn(payload, ref);
    const saved = JSON.parse(JSON.stringify(mock.state())) as ReturnType<typeof mock.state>;
    const now = new Date('2025-05-01T11:00:00+05:30');
    const reborn = new MockGspAdapter({ now: () => now, state: saved });
    const again = new GspClient(reborn, { credentials: () => creds, now: () => now.getTime() });
    // the same document is a duplicate on the reloaded portal, and its IRN can still be cancelled
    await expect(again.generateIrn(payload, ref)).resolves.toMatchObject({
      irn: first.irn,
      recovered: true,
    });
    await expect(again.cancelIrn(first.irn, '2', 'typing mistake')).resolves.toHaveProperty(
      'cancelledAt',
    );
    // a new IRN does not reuse an acknowledgement number
    const next = await again.generateIrn(buildEinvoice({ ...doc, number: 'N/1' }), {
      ...ref,
      number: 'N/1',
    });
    expect(next.ackNo).not.toBe(first.ackNo);
  });

  it('logs in again by itself when the login has expired', async () => {
    const { client, mock, log } = setup();
    await client.generateIrn(payload, ref);
    mock.expireTokens();
    await client.generateIrn(buildEinvoice({ ...doc, number: 'X/2' }), { ...ref, number: 'X/2' });
    expect(log.filter((e) => e.action === 'authenticate')).toHaveLength(2);
    expect(log.some((e) => !e.ok && e.code === 'GD-AUTH')).toBe(true);
  });

  it('cancels within 24 hours, refuses after, and refuses while an e-way bill is active', async () => {
    const { client, advance } = setup();
    const a = await client.generateIrn(payload, ref);
    await expect(client.cancelIrn(a.irn, '2', 'typing mistake')).resolves.toHaveProperty(
      'cancelledAt',
    );

    const b = await client.generateIrn(buildEinvoice({ ...doc, number: 'B/1' }), {
      ...ref,
      number: 'B/1',
    });
    advance(25);
    await expect(client.cancelIrn(b.irn, '2', 'late')).rejects.toMatchObject({ code: '2270' });
  });

  it('never makes a new IRN for a number that had one, even after cancelling it', async () => {
    const { client } = setup();
    const a = await client.generateIrn(payload, ref);
    await client.cancelIrn(a.irn, '1', 'duplicate');
    await expect(client.generateIrn(payload, ref)).rejects.toMatchObject({ code: '2150' });
  });

  it('stops when the credentials are locked, without calling the portal', async () => {
    const { client, lock, log } = setup();
    lock();
    await expect(client.generateIrn(payload, ref)).rejects.toMatchObject({ code: 'GD-LOCKED' });
    expect(log).toEqual([]);
  });

  it('turns a refused password into a login error, and a failure it rehearses into its code', async () => {
    const mock = new MockGspAdapter();
    const client = new GspClient(mock, {
      credentials: () => ({ ...creds, einvPassword: 'wrong' }),
    });
    await expect(client.generateIrn(payload, ref)).rejects.toMatchObject({ code: 'GD-AUTH' });
    const ok = new GspClient(mock, { credentials: () => creds });
    mock.failNext('2189');
    await expect(ok.generateIrn(payload, ref)).rejects.toMatchObject({ code: '2189' });
  });
});

describe('e-way bill through the practice GSP', () => {
  const ewb = {
    fromPincode: 411001,
    toPincode: 560001,
    transDistance: '840',
    vehicleType: 'R',
    vehicleNo: 'MH12AB1234',
  };

  it('generates one valid for a day per 200 km, updates the vehicle and cancels within 24 hours', async () => {
    const { client } = setup();
    const e = await client.generateEwb(ewb);
    expect(e.ewbNo).toMatch(/^\d{12}$/);
    expect(e.validUntil).toBe('2025-05-06T23:59:59+05:30');
    expect(e.distanceKm).toBe(840);
    await client.updateVehicle(e.ewbNo, {
      vehicleNo: 'MH12CD5678',
      fromPlace: 'Pune',
      fromState: '27',
      reason: '1',
      remarks: 'breakdown',
      mode: '1',
    });
    expect((await client.getEwb(e.ewbNo)).vehicleNo).toBe('MH12CD5678');
    await client.cancelEwb(e.ewbNo, '2', 'order cancelled');
    expect((await client.getEwb(e.ewbNo)).status).toBe('cancelled');
    await expect(client.cancelEwb(e.ewbNo, '2', 'again')).rejects.toMatchObject({ code: '312' });
  });

  it('works the distance out when it is sent as 0', async () => {
    const { client } = setup();
    const e = await client.generateEwb({ ...ewb, transDistance: '0' });
    expect(e.distanceKm).toBeGreaterThan(0);
  });

  it('extends only from 8 hours before to 8 hours after expiry', async () => {
    const { client, advance } = setup('2025-05-01T10:00:00+05:30');
    const e = await client.generateEwb({ ...ewb, transDistance: '100' }); // valid to 2 May 23:59
    const extend = () =>
      client.extendEwb(e.ewbNo, {
        remainingKm: 150,
        fromPlace: 'Hubli',
        fromState: '29',
        fromPincode: '580020',
        reason: '1',
        remarks: 'natural calamity',
      });
    await expect(extend()).rejects.toMatchObject({ code: '315' });
    advance(30); // 2 May 16:00, within 8 hours before expiry
    const x = await extend();
    expect(x.validUntil).toBe('2025-05-03T23:59:59+05:30');
  });

  it('refuses to cancel after 24 hours', async () => {
    const { client, advance } = setup();
    const e = await client.generateEwb(ewb);
    advance(25);
    await expect(client.cancelEwb(e.ewbNo, '2', 'late')).rejects.toMatchObject({ code: '315' });
  });
});

describe('credentials', () => {
  const fast = { rounds: 1_000 };

  it('are sealed with a PIN and opened only with that PIN', async () => {
    const sealed = await sealCredentials(creds, '482915', fast);
    expect(JSON.stringify(sealed)).not.toContain('S3cret');
    expect(JSON.stringify(sealed)).not.toContain('demo_api');
    await expect(openCredentials(sealed, '482915', fast)).resolves.toEqual(creds);
    await expect(openCredentials(sealed, '000000', fast)).rejects.toBeInstanceOf(WrongPinError);
  });

  it('are sealed differently each time (fresh salt and nonce)', async () => {
    const a = await sealCredentials(creds, '482915', fast);
    const b = await sealCredentials(creds, '482915', fast);
    expect(a.data).not.toBe(b.data);
    expect(a.salt).not.toBe(b.salt);
  });

  it('need a PIN of at least 6 characters', async () => {
    expect(pinProblem('12345')).toMatch(/at least 6/);
    expect(pinProblem('123456')).toBeNull();
    await expect(sealCredentials(creds, '123', fast)).rejects.toThrow(/at least 6/);
  });
});

describe('the audit log', () => {
  it('keeps every call with secrets removed, and pincodes kept', async () => {
    const { client, log } = setup();
    await client.generateIrn(payload, ref);
    const text = JSON.stringify(log);
    expect(text).not.toContain('S3cret');
    expect(text).not.toContain('practice-einvoice');
    expect(log.find((e) => e.action === 'generateIrn')!.request).toMatchObject({
      SellerDtls: { Pin: 411001 },
    });
  });

  it('redacts secret-looking fields at any depth', () => {
    expect(
      redact({
        a: { password: 'x', AuthToken: 'y', sek: 'z', Pin: 1, nested: [{ client_secret: 's' }] },
      }),
    ).toEqual({
      a: {
        password: REMOVED,
        AuthToken: REMOVED,
        sek: REMOVED,
        Pin: 1,
        nested: [{ client_secret: REMOVED }],
      },
    });
  });
});

describe('the vendor scaffold against a fake server', () => {
  const server = (routes: Record<string, (body: any) => { status: number; json: unknown }>) =>
    (async (url: string, init?: RequestInit) => {
      const path = url.replace('https://gsp.test', '').split('?')[0]!;
      const h = routes[path];
      if (!h)
        return new Response(JSON.stringify({ error: { code: '404', message: 'no route' } }), {
          status: 404,
        });
      const r = h(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify(r.json), { status: r.status });
    }) as unknown as typeof fetch;

  it('logs in, sends the payload with the token, and maps the answer', async () => {
    let sentAuth = '';
    const fetch = (async (url: string, init?: RequestInit) => {
      sentAuth = String((init?.headers as Record<string, string>)?.['authorization'] ?? sentAuth);
      return server({
        '/einvoice/auth': () => ({
          status: 200,
          json: { data: { token: 'tok-1', expiry: '2099-01-01T00:00:00Z' } },
        }),
        '/einvoice/irn': () => ({
          status: 200,
          json: {
            data: {
              Irn: 'abc',
              AckNo: 1,
              AckDt: '2025-05-01 10:00:00',
              SignedInvoice: 'si',
              SignedQRCode: 'qr',
            },
          },
        }),
      })(url, init);
    }) as unknown as typeof globalThis.fetch;
    const client = new GspClient(
      new VendorXAdapter({ baseUrl: 'https://gsp.test', sandbox: true, fetch }),
      { credentials: () => creds },
    );
    const r = await client.generateIrn(payload, ref);
    expect(r).toMatchObject({ irn: 'abc', ackNo: '1', signedQr: 'qr', recovered: false });
    expect(sentAuth).toBe('Bearer tok-1');
  });

  it('maps a vendor error to its code, and a network failure to "offline"', async () => {
    const fetch = server({
      '/einvoice/auth': () => ({ status: 200, json: { data: { token: 't' } } }),
      '/einvoice/irn': () => ({
        status: 400,
        json: { error: { code: '2189', message: 'tax mismatch' } },
      }),
    });
    const client = new GspClient(
      new VendorXAdapter({ baseUrl: 'https://gsp.test', sandbox: true, fetch }),
      { credentials: () => creds },
    );
    await expect(client.generateIrn(payload, ref)).rejects.toMatchObject({
      code: '2189',
      message: 'tax mismatch',
    });

    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const offline = new GspClient(
      new VendorXAdapter({ baseUrl: 'https://gsp.test', sandbox: true, fetch: down }),
      { credentials: () => creds },
    );
    const err = await offline.generateIrn(payload, ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GspError);
    expect((err as GspError).code).toBe('GD-OFFLINE');
  });
});
