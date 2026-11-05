import { GspClient, MockGspAdapter, sealCredentials, type GspCredentials } from '@gst/gsp';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSecretSettingKey } from '../backup/tables';
import { execRaw, queryRows, type Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, DocumentRepo, ReviewRepo, SettingsRepo } from './aggregates';
import { runInTx, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { EinvoiceRepo } from './einvoice';
import { PartyRepo } from './parties';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

const creds = (gstin: string): GspCredentials => ({
  gstin,
  einvUser: 'demo_api',
  einvPassword: 'S3cret!pass',
  ewbUser: 'demo_ewb',
  ewbPassword: 'An0ther!pass',
});

describe.each(DIALECTS)('e-invoice and e-way bill with the practice GSP (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let repo: EinvoiceRepo;
  let gstin: string;
  let now: Date;
  let mock: MockGspAdapter;
  let client: GspClient;
  let docs: Record<string, any>[];
  const link: { jobId?: string | null; documentId?: string | null } = {};

  /** Issued tax invoices to registered parties, oldest first. */
  let invoices: Record<string, any>[];

  beforeAll(async () => {
    d = await openTestDb(dialect);
    opened.push(d);
    ({ ctx } = await seedDemo(d, { documents: 200, parties: 20, items: 30 }));
    repo = new EinvoiceRepo(d);
    // the business and its parties get full addresses, as a real profile would have
    const bizRepo = new BusinessRepo(d);
    const biz = (await bizRepo.get(ctx, ctx.businessId))!;
    gstin = String(biz['gstin']);
    await bizRepo.update(
      ctx,
      { address: { line1: '12 MG Road', city: 'Pune', pincode: '411001', stateCode: '27' } },
      Number(biz['version']),
    );
    const parties = new PartyRepo(d);
    for (const p of await parties.list(ctx))
      await parties.update(
        ctx,
        String(p['id']),
        {
          addresses_json: [
            {
              kind: 'billing',
              line1: '5 Main Street',
              city: String(p['city'] ?? 'Bengaluru'),
              pincode: '560001',
            },
          ],
        },
        Number(p['version']),
      );
    docs = await new DocumentRepo(d).list(ctx);
    const partyById = new Map((await parties.list(ctx)).map((p) => [String(p['id']), p]));
    invoices = docs
      .filter((x) => x['type'] === 'tax_invoice' && x['status'] === 'issued')
      .filter((x) => {
        const p = partyById.get(String(x['party_id']));
        return p && p['gstin'] && !p['is_unregistered'];
      })
      .sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
    await repo.setEinvoicing(ctx, true);
    now = new Date('2026-03-31T10:00:00+05:30');
    mock = new MockGspAdapter({ now: () => now });
    client = new GspClient(mock, {
      credentials: () => creds(gstin),
      now: () => now.getTime(),
      log: (e) => repo.writeLog(ctx, e, link),
    });
  }, 120_000);

  const today = '2026-03-31';

  it('builds the payload from a stored invoice, and checks it as the portal would', async () => {
    const inv = invoices[0]!;
    const { payload, problems } = await repo.previewIrn(ctx, inv['id'], today);
    expect(payload).toMatchObject({
      Version: '1.1',
      DocDtls: { Typ: 'INV', No: inv['number'] },
      SellerDtls: { Gstin: gstin, Pin: 411001, Loc: 'Pune' },
    });
    expect(problems).toEqual([]);
    // the payload adds up to the document
    const val = (payload as any).ValDtls;
    expect(Math.round(val.TotInvVal * 100)).toBe(Number(inv['total_paise']));
  });

  it('generates an IRN through the queue, records it on the document and logs the call without secrets', async () => {
    const inv = invoices[1]!;
    const { job, problems } = await repo.requestIrn(ctx, inv['id'], today);
    expect(problems).toEqual([]);
    expect(job!['status']).toBe('queued');
    // asking again before it is sent gives the same request
    const again = await repo.requestIrn(ctx, inv['id'], today);
    expect(again.job!['id']).toBe(job!['id']);

    const r = await repo.process(ctx, client, { now: () => now, link });
    expect(r).toMatchObject({ done: 1, failed: 0 });
    const e = await repo.einvoiceOf(ctx, inv['id']);
    expect(e).toMatchObject({ status: 'active', recovered: false });
    expect(String(e!['irn'])).toMatch(/^[0-9a-f]{64}$/);
    const doc = (await new DocumentRepo(d).get(ctx, inv['id']))!;
    expect(doc['irn']).toBe(e!['irn']);
    expect(doc['irn_signed_qr']).toBe(e!['signed_qr']);
    expect(doc['irn_ack_no']).toBe(e!['ack_no']);

    const log = await repo.logOf(ctx, inv['id']);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(await runInTx(d, ctx, (tx) => queryRows(d, tx, sqlAllLog(ctx))));
    expect(text).not.toContain('S3cret');
    expect(text).not.toContain('practice-einvoice');

    await expect(repo.requestIrn(ctx, inv['id'], today)).rejects.toThrow(/already has an IRN/);
    // a financial edit and a plain cancellation are refused while the IRN stands
    await expect(
      new DocumentFlowRepo(d).cancelDocument(ctx, inv['id'], Number(doc['version']), 'test'),
    ).rejects.toThrow(/IRN|e-invoic/i);
  });

  it('waits when the portal cannot be reached, then sends it when it can', async () => {
    const inv = invoices[2]!;
    await repo.requestIrn(ctx, inv['id'], today);
    const down = new GspClient(
      {
        ...mock,
        name: 'down',
        sandbox: true,
        authenticate: async () => {
          throw new TypeError('Failed to fetch');
        },
      } as any,
      { credentials: () => creds(gstin), now: () => now.getTime() },
    );
    const first = await repo.process(ctx, down, { now: () => now });
    expect(first).toMatchObject({ done: 0, waiting: 1 });
    const job = (await repo.jobsOf(ctx, inv['id']))[0]!;
    expect(job).toMatchObject({ status: 'queued', last_code: 'GD-OFFLINE', attempts: 1 });
    // not due yet: nothing is sent
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 0 });
    // a minute later it goes
    const later = new Date(now.getTime() + 2 * 60_000);
    expect(await repo.process(ctx, client, { now: () => later })).toMatchObject({ done: 1 });
    expect((await repo.einvoiceOf(ctx, inv['id']))!['status']).toBe('active');
  });

  it('stops a request when the document changed after it was queued, and says so in the inbox', async () => {
    const inv = invoices[3]!;
    await repo.requestIrn(ctx, inv['id'], today);
    await runInTx(d, ctx, (tx) =>
      execRaw(d, tx, `UPDATE documents SET revision = revision + 1 WHERE id = '${inv['id']}'`),
    );
    const r = await repo.process(ctx, client, { now: () => now });
    expect(r.stopped).toBe(1);
    expect((await repo.jobsOf(ctx, inv['id']))[0]).toMatchObject({
      status: 'stopped',
      last_code: 'GD-CHANGED',
    });
    const items = await new ReviewRepo(d).inbox(ctx, { view: 'open' });
    const card = items.find((x) => x['kind'] === 'gsp_job_stopped');
    expect(card?.['suggestion_json']).toMatchObject({
      documentId: inv['id'],
      number: inv['number'],
    });
    // asking again, after the change, makes a new request
    const again = await repo.requestIrn(ctx, inv['id'], today);
    expect(again.job!['status']).toBe('queued');
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
  });

  it('recovers the existing IRN when the portal says it is a duplicate (a lost answer)', async () => {
    const inv = invoices[4]!;
    // the portal already has it (as if our first answer was lost)
    const { payload } = await repo.previewIrn(ctx, inv['id'], today);
    await client.generateIrn(payload, { type: 'INV', number: inv['number'], date: inv['date'] });
    await repo.requestIrn(ctx, inv['id'], today);
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
    expect(await repo.einvoiceOf(ctx, inv['id'])).toMatchObject({
      status: 'active',
      recovered: true,
    });
  });

  it('fails a request the portal refuses, with the code kept for the explanation', async () => {
    const inv = invoices[5]!;
    await repo.requestIrn(ctx, inv['id'], today);
    mock.failNext('2172');
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ failed: 1 });
    expect((await repo.jobsOf(ctx, inv['id']))[0]).toMatchObject({
      status: 'failed',
      last_code: '2172',
    });
  });

  it('makes, extends, re-routes and cancels an e-way bill', async () => {
    const inv = invoices[6]!;
    const { job, problems } = await repo.requestEwb(ctx, inv['id'], {
      mode: 'road',
      distanceKm: 420,
      vehicleNo: 'MH12AB1234',
      vehicleType: 'regular',
    });
    expect(problems).toEqual([]);
    expect(job).toBeTruthy();
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
    const [w] = await repo.ewaybillsOf(ctx, inv['id']);
    expect(w).toMatchObject({ status: 'active', distance_km: 420, vehicle_no: 'MH12AB1234' });
    expect(String(w!['valid_until'])).toBe('2026-04-03T23:59:59+05:30');
    expect((await new DocumentRepo(d).get(ctx, inv['id']))!['eway_bill_no']).toBe(w!['ewb_no']);
    await expect(
      repo.requestEwb(ctx, inv['id'], {
        mode: 'road',
        distanceKm: 10,
        vehicleNo: 'MH12AB1234',
        vehicleType: 'regular',
      }),
    ).rejects.toThrow(/already has an active/);

    // the vehicle broke down
    await repo.requestVehicleUpdate(ctx, String(w!['id']), {
      vehicleNo: 'MH12CD5678',
      fromPlace: 'Solapur',
      fromState: '27',
      reason: '1',
      remarks: 'breakdown',
      mode: '1',
    });
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
    const moved = (await repo.ewaybillsOf(ctx, inv['id']))[0]!;
    expect(moved['vehicle_no']).toBe('MH12CD5678');
    expect(moved['history_json']).toHaveLength(1);

    // too early to extend; then within the window
    await expect(
      repo.requestEwbExtend(
        ctx,
        String(w!['id']),
        {
          remainingKm: 100,
          fromPlace: 'Hubli',
          fromState: '29',
          fromPincode: '580020',
          reason: '1',
          remarks: 'flood',
        },
        now,
      ),
    ).rejects.toThrow(/8 hours/);
    const nearEnd = new Date('2026-04-03T18:00:00+05:30');
    await repo.requestEwbExtend(
      ctx,
      String(w!['id']),
      {
        remainingKm: 100,
        fromPlace: 'Hubli',
        fromState: '29',
        fromPincode: '580020',
        reason: '1',
        remarks: 'flood',
      },
      nearEnd,
    );
    // the practice portal's clock moves too (it reads `now`)
    const before = now;
    now = nearEnd;
    try {
      expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
      const ext = (await repo.ewaybillsOf(ctx, inv['id']))[0]!;
      // 100 km more from 3 April: valid to the end of 4 April
      expect(ext['valid_until']).toBe('2026-04-04T23:59:59+05:30');
      expect(ext['history_json']).toHaveLength(2);
      expect((await new DocumentRepo(d).get(ctx, inv['id']))!['eway_valid_until']).toBe(
        Date.parse('2026-04-04T23:59:59+05:30'),
      );
      // and cancelling it is too late now (more than 24 hours since it was made)
      await expect(repo.requestEwbCancel(ctx, String(w!['id']), '2', 'late', now)).rejects.toThrow(
        /24 hours/,
      );
    } finally {
      now = before;
    }
  });

  it('cancels an IRN within 24 hours (and the document with it), and refuses after, pointing to a credit note', async () => {
    const inv = invoices[7]!;
    await repo.requestIrn(ctx, inv['id'], today);
    await repo.process(ctx, client, { now: () => now });
    await expect(repo.requestIrnCancel(ctx, inv['id'], '2', '  ', now)).rejects.toThrow(/Say why/);
    await repo.requestIrnCancel(ctx, inv['id'], '2', 'wrong buyer', now);
    expect(await repo.process(ctx, client, { now: () => now })).toMatchObject({ done: 1 });
    expect(await repo.einvoiceOf(ctx, inv['id'])).toMatchObject({
      status: 'cancelled',
      cancel_reason: '2',
      cancel_remarks: 'wrong buyer',
    });
    expect((await new DocumentRepo(d).get(ctx, inv['id']))!['status']).toBe('cancelled');

    const late = invoices[8]!;
    await repo.requestIrn(ctx, late['id'], today);
    await repo.process(ctx, client, { now: () => now });
    const dayLater = new Date(now.getTime() + 25 * 3_600_000);
    await expect(repo.requestIrnCancel(ctx, late['id'], '2', 'too late', dayLater)).rejects.toThrow(
      /credit note/,
    );
  });

  it('refuses to cancel an IRN while its e-way bill is active', async () => {
    const inv = invoices[9]!;
    await repo.requestIrn(ctx, inv['id'], today);
    await repo.process(ctx, client, { now: () => now });
    await repo.requestEwb(ctx, inv['id'], {
      mode: 'road',
      distanceKm: 50,
      vehicleNo: 'MH12AB1234',
      vehicleType: 'regular',
    });
    await repo.process(ctx, client, { now: () => now });
    await expect(repo.requestIrnCancel(ctx, inv['id'], '2', 'x', now)).rejects.toThrow(
      /e-way bill/,
    );
  });

  it('lists the documents still waiting for an IRN, and none when e-invoicing is off', async () => {
    const waiting = await repo.waitingForIrn(ctx, '2024-04-01', '2026-03-31');
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((x) => x['type'] !== 'bill_of_supply')).toBe(true);
    expect(waiting.find((x) => x['id'] === invoices[1]!['id'])).toBeUndefined(); // has one
    await repo.setEinvoicing(ctx, false);
    expect(await repo.waitingForIrn(ctx, '2024-04-01', '2026-03-31')).toEqual([]);
    await repo.setEinvoicing(ctx, true);
  });

  it('queues and sends a batch of IRNs in bulk, and says how long each takes', async () => {
    const waiting = (await repo.waitingForIrn(ctx, '2024-04-01', '2026-03-31')).slice(0, 40);
    expect(waiting.length).toBeGreaterThanOrEqual(10);
    const t0 = performance.now();
    let queued = 0;
    for (const w of waiting) {
      const r = await repo.requestIrn(ctx, String(w['id']), today);
      if (r.job) queued += 1;
    }
    const t1 = performance.now();
    const out = await repo.process(ctx, client, { now: () => now, link });
    const t2 = performance.now();
    expect(out.done).toBe(queued);
    expect(out.failed).toBe(0);
    const perRequest = (t1 - t0) / waiting.length;
    const perSend = (t2 - t1) / Math.max(1, queued);
    console.info(
      `[perf] ${dialect}: ${queued} IRN requests queued at ${perRequest.toFixed(1)} ms each, sent at ${perSend.toFixed(1)} ms each`,
    );
    // generous: the budget is for the person's wait, the portal's own time is not ours
    expect(perRequest).toBeLessThan(500);
    expect(perSend).toBeLessThan(500);
  }, 120_000);

  it('keeps the credentials sealed, as a secret setting that never travels in a backup', async () => {
    const sealed = await sealCredentials(creds(gstin), '482915', { rounds: 1_000 });
    await repo.saveSealedCredentials(ctx, sealed);
    expect(await repo.sealedCredentials(ctx)).toEqual(sealed);
    expect(isSecretSettingKey('secret.gsp.credentials')).toBe(true);
    const stored = JSON.stringify(await new SettingsRepo(d).list(ctx));
    expect(stored).not.toContain('S3cret');
  });

  it('keeps the GSP configuration, and refuses an address that is not https', async () => {
    expect(await repo.gspConfig(ctx)).toEqual({ mode: 'practice', sandbox: true });
    await expect(
      repo.setGspConfig(ctx, { mode: 'vendor-x', baseUrl: 'http://x', sandbox: true }),
    ).rejects.toThrow(/https/);
    await repo.setGspConfig(ctx, {
      mode: 'vendor-x',
      baseUrl: 'https://sandbox.gsp.example',
      sandbox: true,
    });
    expect((await repo.gspConfig(ctx)).mode).toBe('vendor-x');
    await repo.setGspConfig(ctx, { mode: 'practice', sandbox: true });
  });
});

const sqlAllLog = (ctx: Ctx) => sql`SELECT * FROM gsp_log WHERE business_id = ${ctx.businessId}`;
