/**
 * CA and client portals against a real Postgres and MinIO (prompt 47): sharing a business with an accountant
 * for a financial year (invite, accept, what they can and cannot reach, revoke), the client routes under
 * row-level security, comments in the owner's inbox, the export pack built and downloaded, and the customer's
 * public links (token space, revoke, expiry, the portal switch, PDF, pay through the mock gateway, questions,
 * statements, rate limit).
 */
import { DocumentFlowRepo, PartyRepo, type Ctx } from '@gst/db';
import { MockGateway } from '@gst/payments';
import { unzipSync } from 'fflate';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { PaymentsService } from '../src/payments/service';
import { buildExportPack, ExportPackService } from '../src/portals/export-pack';
import { hashToken, PortalService, newToken } from '../src/portals/links';
import { ShareService } from '../src/portals/shares';
import { makeStorage, type Storage } from '../src/storage/s3';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startMinio, startPostgres, type MinioStack, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

const GSTIN = '27AABCD1234E1Z8';
const KEY = Buffer.alloc(32, 7).toString('base64');
const PORTAL = 'https://app.example';
let clock = Date.parse('2026-11-07T10:00:00+05:30');

let pg: PgStack;
let minio: MinioStack;
let storage: Storage;
let t: TestApp;
let owner: Client;
let ca: Client;
let stranger: Client;
let orgId: string;
let businessId: string;
let userId: string;
let partyId: string;
let gw: MockGateway;
let payments: PaymentsService;
let portals: { shares: ShareService; links: PortalService; packs: ExportPackService };
const invoices: Record<string, string> = {};

const ctx = (): Ctx => ({ orgId, businessId, actor: userId, deviceId: 'api' });
const sql = (q: string, params: unknown[] = []) =>
  pg.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(q, params as never[]);
  }) as Promise<Record<string, any>[]>;
const body = (o: unknown) => ({ method: 'POST', body: JSON.stringify(o) });
const org = () => `/v1/orgs/${orgId}`;

async function issue(date: string, name = 'Buyer') {
  const flow = new DocumentFlowRepo(pg.app);
  const saved = await flow.saveDraft(ctx(), toRows(invoiceDraft(partyId, name, date, 10_000n)));
  const r = await flow.issueDraft(
    ctx(),
    String(saved.document['id']),
    Number(saved.document['version']),
  );
  return String(r.document['id']);
}
async function share(extra: Record<string, unknown> = {}) {
  const r = await owner.json<any>(
    `${org()}/shares`,
    body({
      businessId,
      email: 'ca@example.com',
      fy: '2026-27',
      perms: { read: true, gst: true, export: true, comment: true },
      ...extra,
    }),
  );
  expect(r.status).toBe(201);
  return r.body as { id: string; status: string; from: string; to: string };
}
async function accept(id: string, who = ca) {
  return who.json<any>(`/v1/share-invites/${id}/accept`, { method: 'POST' });
}
/** Every id-shaped value in an answer, the request id (which every error carries) aside. */
const uuids = (v: unknown) =>
  JSON.stringify(v, (k, x) => (k === 'requestId' ? undefined : x)).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
  ) ?? [];
const sansId = (v: any) => ({ ...v, error: { ...v.error, requestId: undefined } });
const SYNC_ENV = {
  POWERSYNC_URL: 'http://powersync.invalid:8080',
  POWERSYNC_JWT_SECRET: 'portal-test-secret-'.padEnd(48, 'x'),
  // the fuzz below makes hundreds of public requests from one address; the limit itself is tested last
  RATE_LIMIT_PORTAL_PER_MINUTE: '100000',
};
const pub = (token: string, path = '', init: RequestInit = {}) =>
  t.app.request(`/v1/p/${token}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
const pubJson = async (token: string, path = '', init: RequestInit = {}) => {
  const r = await pub(token, path, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
  [pg, minio] = await Promise.all([startPostgres(), startMinio()]);
  storage = makeStorage(
    loadConfig({
      DATABASE_URL: pg.adminUrl,
      S3_ENDPOINT: minio.endpoint,
      S3_ACCESS_KEY: minio.accessKey,
      S3_SECRET_KEY: minio.secretKey,
      S3_BUCKET: 'gstdesk-portals',
      S3_SSE: 'none',
    }),
  )!;
  await storage.ensureBucket();
  gw = new MockGateway();
  const log = pino({ level: 'silent' });
  payments = new PaymentsService({ db: pg.app, secretsKey: KEY, log, adapterFor: () => gw });
  portals = {
    shares: new ShareService(pg.app, () => clock),
    links: new PortalService({
      db: pg.app,
      portalUrl: PORTAL,
      secretsKey: KEY,
      payments,
      now: () => clock,
    }),
    packs: new ExportPackService({ db: pg.app, storage, log, enqueue: null, now: () => clock }),
  };
  t = makeTestApp(pg, { storage, payments, portals, env: SYNC_ENV });
  owner = await t.signIn('portal-owner@example.com', 'Asha');
  ca = await t.signIn('ca@example.com', 'Meera CA');
  stranger = await t.signIn('stranger@example.com', 'Nobody');
  userId = String(
    (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'portal-owner@example.com'`)[0]!['id'],
  );
  orgId = (await owner.json<{ id: string }>('/v1/orgs', body({ name: 'Asha Traders' }))).body.id;
  businessId = (
    await owner.json<{ id: string }>(
      `${org()}/businesses`,
      body({ legalName: 'Asha Traders', tradeName: 'Asha Traders', stateCode: '27', gstin: GSTIN }),
    )
  ).body.id;
  partyId = String(
    (
      await new PartyRepo(pg.app).create(ctx(), {
        type: 'customer',
        name: 'Buyer & Co',
        state_code: '27',
        gstin: '27AAACB1234F1ZD',
      })
    )['id'],
  );
  invoices['may'] = await issue('2026-05-10');
  invoices['oct'] = await issue('2026-10-15');
  invoices['old'] = await issue('2025-12-01');
}, 180_000);
afterAll(async () => {
  await Promise.all([pg?.stop(), minio?.stop()]);
});

describe('sharing with an accountant', () => {
  let shareId = '';

  it('the owner shares a financial year; only the invited address sees the invitation', async () => {
    const s = await share();
    shareId = s.id;
    expect(s).toMatchObject({ status: 'pending', from: '2026-04-01', to: '2027-03-31' });
    const mine = await ca.json<any[]>('/v1/me/share-invites');
    expect(mine.body.map((i) => i.id)).toEqual([shareId]);
    expect(mine.body[0]).toMatchObject({ orgName: 'Asha Traders', businessName: 'Asha Traders' });
    expect((await stranger.json<any[]>('/v1/me/share-invites')).body).toEqual([]);
    expect((await accept(shareId, stranger)).status).toBe(404);
    // a share needs an address or a number, and a year or dates
    expect((await owner.json(`${org()}/shares`, body({ businessId, fy: '2026-27' }))).status).toBe(
      400,
    );
    expect(
      (
        await owner.json(
          `${org()}/shares`,
          body({ businessId, email: 'x@example.com', fy: '2026-28' }),
        )
      ).status,
    ).toBe(422);
  });

  it('nothing is reachable before accepting', async () => {
    const r = await ca.json(`${org()}/client/overview?businessId=${businessId}`);
    expect(r.status).toBe(404);
    expect((await ca.json<any[]>('/v1/me/clients')).body).toEqual([]);
  });

  it('once accepted the accountant reads the shared business, inside the shared dates only', async () => {
    expect((await accept(shareId)).status).toBe(200);
    const ov = await ca.json<any>(`${org()}/client/overview?businessId=${businessId}`);
    expect(ov.status).toBe(200);
    expect(ov.body.access).toMatchObject({ via: 'share', from: '2026-04-01', to: '2027-03-31' });
    expect(ov.body.counts.sales).toBe(2);
    expect(ov.body.business.gstin).toBe(GSTIN);
    const docs = await ca.json<any>(`${org()}/client/documents?businessId=${businessId}`);
    expect(docs.body.count).toBe(2);
    expect(docs.body.rows.map((d: any) => d.id).sort()).toEqual(
      [invoices['may'], invoices['oct']].sort(),
    );
    // the one from the earlier year is "not found", by id too
    expect(
      (await ca.json(`${org()}/client/documents/${invoices['old']}?businessId=${businessId}`))
        .status,
    ).toBe(404);
    const one = await ca.json<any>(
      `${org()}/client/documents/${invoices['oct']}?businessId=${businessId}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.lines.length).toBeGreaterThan(0);
    const pdf = await ca.fetch(
      `${org()}/client/documents/${invoices['oct']}/pdf?businessId=${businessId}`,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
    // the business list shows only the shared one
    const biz = await ca.json<any[]>(`${org()}/businesses`);
    expect(biz.body.map((b) => b.id)).toEqual([businessId]);
    expect((await ca.json<any>(`${org()}/permissions`)).body.permissions.roleName).toBe(
      'Shared with you',
    );
  });

  it('the share is read-only: writes, the team, sync and other businesses are refused', async () => {
    expect(
      (await ca.json(`${org()}/businesses`, body({ legalName: 'Mine', stateCode: '27' }))).status,
    ).toBe(403);
    expect((await ca.json(`${org()}/team`)).status).toBe(403);
    expect((await ca.json(`${org()}/shares?businessId=${businessId}`)).status).toBe(403);
    expect(
      (await ca.json('/v1/sync/token', body({ orgId, deviceName: 'CA laptop', platform: 'web' })))
        .status,
    ).toBe(404);
    const other = (
      await owner.json<{ id: string }>(
        `${org()}/businesses`,
        body({ legalName: 'Second Shop', stateCode: '27' }),
      )
    ).body.id;
    expect((await ca.json(`${org()}/client/overview?businessId=${other}`)).status).toBe(404);
    expect((await ca.json(`${org()}/businesses/${other}`)).status).toBe(404);
    // the filing routes: a period outside the share is refused before anything else
    expect(
      (await ca.json(`${org()}/filing/pack?businessId=${businessId}&period=122025`)).status,
    ).toBe(403);
    expect(
      (await ca.json(`${org()}/filing/pack?businessId=${businessId}&period=102026`)).status,
    ).toBe(
      503, // no filing service in this test app: the share got through
    );
  });

  it('the accountant appears on the board and the client list, and a member sees everything', async () => {
    const board = await ca.json<any>('/v1/me/filing-board');
    expect(board.body.rows.map((r: any) => r.gstin)).toEqual([GSTIN]);
    const clients = await ca.json<any[]>('/v1/me/clients');
    expect(clients.body).toHaveLength(1);
    expect(clients.body[0]).toMatchObject({ via: 'share', documents: 2, gstin: GSTIN });
    expect(clients.body[0].share).toMatchObject({ from: '2026-04-01' });
    // the owner's own client view has no date limit
    const docs = await owner.json<any>(`${org()}/client/documents?businessId=${businessId}`);
    expect(docs.status, JSON.stringify(docs.body)).toBe(200);
    expect(docs.body.count).toBe(3);
    const mine = await owner.json<any[]>('/v1/me/clients');
    expect(mine.body.find((c) => c.businessId === businessId)).toMatchObject({ via: 'member' });
  });

  it('a comment lands in the owner’s inbox with the accountant’s name', async () => {
    const r = await ca.json<any>(
      `${org()}/client/comments`,
      body({ businessId, documentId: invoices['oct'], text: 'HSN on line 1 looks wrong' }),
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ byName: 'Meera CA', documentId: invoices['oct'] });
    const items = await sql(`SELECT suggestion_json FROM review_items WHERE kind = 'ca_comment'`);
    expect(items).toHaveLength(1);
    expect(items[0]!['suggestion_json']).toMatchObject({ text: 'HSN on line 1 looks wrong' });
    const list = await ca.json<any[]>(`${org()}/client/comments?businessId=${businessId}`);
    expect(list.body).toHaveLength(1);
    // a document outside the share cannot be commented on
    expect(
      (
        await ca.json(
          `${org()}/client/comments`,
          body({ businessId, documentId: invoices['old'], text: 'x' }),
        )
      ).status,
    ).toBe(404);
  });

  it('revoking ends access from the next request', async () => {
    const r = await owner.json<any>(`${org()}/shares/${shareId}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('revoked');
    expect((await ca.json(`${org()}/client/overview?businessId=${businessId}`)).status).toBe(404);
    expect((await ca.json<any[]>('/v1/me/clients')).body).toEqual([]);
    expect((await ca.json<any>('/v1/me/filing-board')).body.rows).toEqual([]);
  });

  it('a share without export cannot take a pack, and a share without comment cannot comment', async () => {
    const s = await share({ perms: { read: true, gst: false, export: false, comment: false } });
    await accept(s.id);
    expect(
      (
        await ca.json(
          `${org()}/client/export-packs`,
          body({ businessId, from: '2026-04-01', to: '2026-10-31' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await ca.json(`${org()}/client/comments`, body({ businessId, text: 'hi' }))).status,
    ).toBe(403);
    // without the GST module the board has nothing, and the overview no cells
    expect((await ca.json<any>('/v1/me/filing-board')).body.rows).toEqual([]);
    expect(
      (await ca.json<any>(`${org()}/client/overview?businessId=${businessId}`)).body.cells,
    ).toEqual([]);
    await owner.json(`${org()}/shares/${s.id}`, { method: 'DELETE' });
  });

  it('an expired invitation cannot be accepted', async () => {
    const s = await share();
    clock += 15 * 86_400_000;
    expect((await accept(s.id)).status).toBe(410);
    clock -= 15 * 86_400_000;
    const list = await owner.json<any[]>(`${org()}/shares?businessId=${businessId}`);
    expect(list.body.find((x) => x.id === s.id).status).toBe('declined');
  });
});

describe('the export pack', () => {
  it('holds the registers, return files, Tally XML, statements and PDFs, and downloads from the store', async () => {
    const s = await share();
    await accept(s.id);
    // outside the share
    expect(
      (
        await ca.json(
          `${org()}/client/export-packs`,
          body({ businessId, from: '2025-04-01', to: '2026-10-31' }),
        )
      ).status,
    ).toBe(403);
    const r = await ca.json<any>(
      `${org()}/client/export-packs`,
      body({ businessId, from: '2026-04-01', to: '2026-10-31' }),
    );
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('done');
    const names = r.body.manifest.files.map((f: any) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'registers/sales-register.csv',
        'registers/purchase-register.csv',
        `gst/GSTR1_${GSTIN}_052026.json`,
        `gst/GSTR3B_${GSTIN}_102026.json`,
        'tally/masters.xml',
        'tally/vouchers.xml',
        'ledger/party-statements.csv',
        'ledger/party-outstanding.csv',
        'manifest.json',
      ]),
    );
    expect(names.filter((n: string) => n.startsWith('pdf/'))).toHaveLength(2);
    expect(r.body.manifest.counts).toMatchObject({
      sales_register: 2,
      pdfs: 2,
      party_statements: 1,
    });
    const dl = await ca.json<{ url: string }>(`${org()}/client/export-packs/${r.body.id}/download`);
    expect(dl.status).toBe(200);
    const zip = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
    const entries = unzipSync(new Uint8Array(zip));
    expect(Object.keys(entries)).toEqual(expect.arrayContaining(names));
    const csv = Buffer.from(entries['registers/sales-register.csv']!).toString();
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(Buffer.from(entries['tally/vouchers.xml']!).toString()).toContain('<VOUCHER');
    const list = await ca.json<any[]>(`${org()}/client/export-packs?businessId=${businessId}`);
    expect(list.body[0].id).toBe(r.body.id);
    await owner.json(`${org()}/shares/${s.id}`, { method: 'DELETE' });
  });

  it('the builder alone: a span with nothing in it still makes a pack', async () => {
    const { manifest } = await buildExportPack(pg.app, ctx(), '2024-04-01', '2024-04-30', clock);
    expect(manifest.counts['sales_register']).toBe(0);
    expect(manifest.files.map((f) => f.name)).toContain('manifest.json');
  });
});

describe('the customer’s links', () => {
  let token = '';
  let linkId = '';
  const made = async (extra: Record<string, unknown> = {}) => {
    const r = await owner.json<any>(
      `${org()}/portal/links`,
      body({ businessId, documentId: invoices['oct'], ...extra }),
    );
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(new RegExp(`^${PORTAL}/p/[A-Za-z0-9_-]{22}$`));
    return { id: r.body.id as string, token: r.body.url.split('/p/')[1] as string };
  };

  it('a link is dark until the business turns its pages on', async () => {
    const m = await made();
    token = m.token;
    linkId = m.id;
    expect((await pubJson(token)).status).toBe(410);
    const st = await owner.json<any>(`${org()}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify({ businessId, enabled: true, linkDays: 30 }),
    });
    expect(st.body).toMatchObject({
      enabled: true,
      linkDays: 30,
      statements: true,
      questions: true,
    });
  });

  it('shows exactly one invoice and nothing of ours', async () => {
    const r = await pubJson(token);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('document');
    expect(r.body.business).toMatchObject({ name: 'Asha Traders', gstin: GSTIN });
    expect(r.body.document).toMatchObject({
      type: 'tax_invoice',
      date: '2026-10-15',
      payStatus: 'unpaid',
      status: 'issued',
    });
    expect(r.body.document.lines.length).toBeGreaterThan(0);
    expect(r.body.document.balancePaise).toBe(r.body.document.totalPaise);
    expect(r.body.pay).toEqual({ available: false, url: null });
    expect(uuids(r.body)).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain(orgId);
    // the owner sees the link with its address again and the view counted
    const list = await owner.json<any[]>(
      `${org()}/portal/links?businessId=${businessId}&documentId=${invoices['oct']}`,
    );
    expect(list.body[0]).toMatchObject({ id: linkId, status: 'live', url: `${PORTAL}/p/${token}` });
    expect(list.body[0].views).toBeGreaterThanOrEqual(1);
  });

  it('the token space: nothing near a real token, or made up, answers anything but "not found"', async () => {
    const notFound = await pubJson('A'.repeat(22));
    expect(notFound.status).toBe(404);
    const seen = new Set<number>();
    for (let i = 0; i < 22; i++) {
      const c = token[i] === 'A' ? 'B' : 'A';
      const near = token.slice(0, i) + c + token.slice(i + 1);
      const r = await pubJson(near);
      seen.add(r.status);
      expect(sansId(r.body)).toEqual(sansId(notFound.body));
    }
    expect([...seen]).toEqual([404]);
    for (let i = 0; i < 200; i++) expect((await pub(newToken())).status).toBe(404);
    for (const bad of ['', 'short', token.slice(0, 21), `${token}A`, `${token}/`, '../' + token])
      expect([404, 400]).toContain((await pub(bad)).status);
    // the stored form is the hash, never the token
    const rows = await sql(`SELECT token_hash, token_enc FROM portal_links WHERE id = '${linkId}'`);
    expect(rows[0]!['token_hash']).toBe(hashToken(token));
    expect(rows[0]!['token_enc']).not.toContain(token);
  });

  it('the PDF downloads', async () => {
    const r = await pub(token, '/pdf');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(
      Buffer.from(await r.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
  });

  it('pays through the gateway once the business is connected, and shows paid after the webhook', async () => {
    expect((await pubJson(token, '/pay', { method: 'POST' })).status).toBe(503);
    const g = await owner.json<any>(`${org()}/payments/gateway`, {
      method: 'PUT',
      body: JSON.stringify({
        businessId,
        keyId: 'rzp_test_abc123XYZ',
        keySecret: 'super-secret-key',
        webhookSecret: 'hook-secret',
      }),
    });
    expect(g.status).toBe(200);
    expect((await pubJson(token)).body.pay).toEqual({ available: true, url: null });
    const pay = await pubJson(token, '/pay', { method: 'POST' });
    expect(pay.status).toBe(200);
    expect(pay.body.url).toMatch(/^https:\/\/pay\.example\//);
    expect(pay.body.amountPaise).toBeGreaterThan(0);
    // asking again gives the same live link, and the page now carries it
    expect((await pubJson(token, '/pay', { method: 'POST' })).body.url).toBe(pay.body.url);
    expect((await pubJson(token)).body.pay.url).toBe(pay.body.url);
    const gatewayId = String(g.body.webhookPath).split('/').pop()!;
    const linkRef = gw.links.at(-1)!.id;
    const hook = gw.payBody({ linkId: linkRef }, pay.body.amountPaise);
    const res = await t.app.request(`/v1/webhooks/razorpay/${gatewayId}`, {
      method: 'POST',
      body: hook.raw,
      headers: { 'content-type': 'application/json', ...hook.headers },
    });
    expect(res.status).toBe(200);
    const after = await pubJson(token);
    expect(after.body.document.payStatus).toBe('paid');
    expect(after.body.document.balancePaise).toBe(0);
    expect(after.body.pay.available).toBe(false);
    expect((await pubJson(token, '/pay', { method: 'POST' })).status).toBe(409);
  });

  it('a question lands in the owner’s inbox once', async () => {
    const q = body({ name: 'Ravi', contact: '9876543210', text: 'Please send the e-way bill too' });
    expect((await pubJson(token, '/question', q)).status).toBe(201);
    expect((await pubJson(token, '/question', q)).status).toBe(201);
    const items = await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'portal_question'`,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!['suggestion_json']).toMatchObject({
      name: 'Ravi',
      text: 'Please send the e-way bill too',
      documentId: invoices['oct'],
    });
    expect((await pubJson(token, '/question', body({ text: '' }))).status).toBe(400);
    await owner.json(`${org()}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify({ businessId, questions: false }),
    });
    expect((await pubJson(token, '/question', q)).status).toBe(410);
    expect((await pubJson(token)).body.questions).toBe(false);
  });

  it('a statement link shows the party’s account, and can be turned off on its own', async () => {
    const r = await owner.json<any>(`${org()}/portal/links`, body({ businessId, partyId }));
    expect(r.status).toBe(201);
    const st = r.body.url.split('/p/')[1] as string;
    const page = await pubJson(st);
    expect(page.status).toBe(200);
    expect(page.body.kind).toBe('statement');
    expect(page.body.party.name).toBe('Buyer & Co');
    expect(page.body.lines.length).toBeGreaterThanOrEqual(3);
    expect(uuids(page.body)).toEqual([]);
    expect((await pub(st, '/pdf')).status).toBe(404);
    await owner.json(`${org()}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify({ businessId, statements: false }),
    });
    expect((await pubJson(st)).status).toBe(410);
    expect((await pubJson(token)).status).toBe(200);
    expect((await owner.json(`${org()}/portal/links`, body({ businessId, partyId }))).status).toBe(
      410,
    );
    // a draft has no link, and neither document nor party is refused
    expect(
      (
        await owner.json(
          `${org()}/portal/links`,
          body({ businessId, documentId: invoices['oct'], partyId }),
        )
      ).status,
    ).toBe(400);
  });

  it('revoked and expired links are gone; the page says so without saying more', async () => {
    const m = await made({ days: 1 });
    expect((await pubJson(m.token)).status).toBe(200);
    clock += 2 * 86_400_000;
    const expired = await pubJson(m.token);
    expect(expired.status).toBe(410);
    expect(uuids(expired.body)).toEqual([]);
    clock -= 2 * 86_400_000;
    const list = await owner.json<any[]>(`${org()}/portal/links?businessId=${businessId}`);
    expect(list.body.find((l) => l.id === m.id).status).toBe('live');
    const rv = await owner.json<any>(`${org()}/portal/links/${m.id}`, { method: 'DELETE' });
    expect(rv.body.status).toBe('revoked');
    expect((await pubJson(m.token)).status).toBe(410);
    expect((await owner.json(`${org()}/portal/links/${m.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
    // turning the pages off darkens every link at once
    await owner.json(`${org()}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify({ businessId, enabled: false }),
    });
    expect((await pubJson(token)).status).toBe(410);
    await owner.json(`${org()}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify({ businessId, enabled: true }),
    });
  });

  it('a viewer cannot make links; a share cannot reach the portal routes', async () => {
    const s = await share();
    await accept(s.id);
    expect(
      (await ca.json(`${org()}/portal/links`, body({ businessId, documentId: invoices['oct'] })))
        .status,
    ).toBe(403);
    expect((await ca.json(`${org()}/portal/settings?businessId=${businessId}`)).status).toBe(403);
    await owner.json(`${org()}/shares/${s.id}`, { method: 'DELETE' });
  });

  it('is rate limited per address and per token', async () => {
    const small = makeTestApp(pg, {
      storage,
      payments,
      portals,
      env: { RATE_LIMIT_PORTAL_PER_MINUTE: '3' },
    });
    const hit = () => small.app.request(`/v1/p/${token}`);
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    const r = await hit();
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    // the signed-in routes are untouched
    expect((await owner.json(`${org()}/portal/settings?businessId=${businessId}`)).status).toBe(
      200,
    );
  });
});
