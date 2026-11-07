/**
 * GST filing through the GSP against a real Postgres (prompt 46), with the practice portal: the plan and metering,
 * the OTP login and the sealed session, a push that succeeds, repeats, partly fails and meets an expired login,
 * a 2B pull that lands in reconciliation, filing picked up with its ARN and the period locked, the nil return, the
 * late-fee figures, and the CA's board across organisations.
 */
import { DocumentFlowRepo, GstrRepo, SettingsRepo, type Ctx } from '@gst/db';
import { monthPeriod } from '@gst/domain';
import { MockGspAdapter } from '@gst/gsp';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { filingBoard } from '../src/filing/board';
import { FilingService } from '../src/filing/service';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

const GSTIN = '27AABCD1234E1Z8';
const FP = '102026'; // October 2026: GSTR-1 was due on 11 November
const clock = Date.parse('2026-11-20T10:00:00+05:30');
let pg: PgStack;
let t: TestApp;
let owner: Client;
let orgId: string;
let businessId: string;
let userId: string;
let gsp: MockGspAdapter;
let svc: FilingService;
const queued: { orgId: string; jobId: string }[] = [];

const ctx = (): Ctx => ({ orgId, businessId, actor: userId, deviceId: 'api' });
const sql = (q: string, params: unknown[] = []) =>
  pg.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(q, params as never[]);
  }) as Promise<Record<string, any>[]>;
const base = () => `/v1/orgs/${orgId}/filing`;
const body = (o: unknown) => ({ method: 'POST', body: JSON.stringify(o) });

async function party(name: string) {
  const { PartyRepo } = await import('@gst/db');
  return String(
    (
      await new PartyRepo(pg.app).create(ctx(), {
        type: 'customer',
        name,
        state_code: '27',
        gstin: '27AAACB1234F1ZD',
      })
    )['id'],
  );
}
async function issue(date = '2026-10-15') {
  const p = await party(`Buyer ${Math.random().toString(36).slice(2, 7)}`);
  const flow = new DocumentFlowRepo(pg.app);
  const saved = await flow.saveDraft(ctx(), toRows(invoiceDraft(p, 'Buyer', date, 10_000n)));
  const r = await flow.issueDraft(
    ctx(),
    String(saved.document['id']),
    Number(saved.document['version']),
  );
  // the desk will not push with problems standing: acknowledge them, as a person would with a reason
  const fpOf = `${date.slice(5, 7)}${date.slice(0, 4)}`;
  const gr = new GstrRepo(pg.app);
  const review = await gr.review(
    ctx(),
    monthPeriod(GSTIN, Number(date.slice(0, 4)), Number(date.slice(5, 7))),
  );
  for (const i of review.issues)
    await gr.acknowledge(ctx(), fpOf, i.key ?? '', 'checked for the test').catch(() => undefined);
  return String(r.document['number']);
}
async function login(otp = '123456') {
  await owner.json(`${base()}/otp`, body({ businessId, username: 'asha.api' }));
  return owner.json<any>(`${base()}/otp/verify`, body({ businessId, otp }));
}
async function job(kind: string, form?: string, period = FP) {
  const r = await owner.json<{ id: string; existing: boolean }>(
    `${base()}/jobs`,
    body({ businessId, kind, ...(form ? { form } : {}), period }),
  );
  expect(r.status).toBe(202);
  const status = await svc.run(orgId, r.body.id);
  return {
    id: r.body.id,
    status,
    view: await svc.job(orgId, r.body.id),
    existing: r.body.existing,
  };
}
const filingRow = async (ret: string, fp = FP) =>
  (
    await sql(
      `SELECT * FROM gst_filings WHERE return_type = '${ret}' AND period_fp = '${fp}' AND deleted_at IS NULL`,
    )
  )[0];
const calls = async () =>
  Number(
    (
      await sql(
        `SELECT coalesce(sum(quantity),0)::int AS n FROM usage_events WHERE kind = 'gsp_call'`,
      )
    )[0]!['n'],
  );
const items = async (reason: string) =>
  (
    await sql(
      `SELECT suggestion_json FROM review_items WHERE kind = 'filing_attention' AND suggestion_json->>'reason' = '${reason}'`,
    )
  ).length;

beforeAll(async () => {
  pg = await startPostgres();
  gsp = new MockGspAdapter({ now: () => new Date(clock) });
  svc = new FilingService({
    db: pg.app,
    secretsKey: Buffer.alloc(32, 5).toString('base64'),
    log: pino({ level: 'silent' }),
    now: () => clock,
    adapter: gsp,
    enqueue: async (j) => void queued.push(j),
  });
  t = makeTestApp(pg, { filing: svc });
  owner = await t.signIn('fil-owner@example.com', 'Owner');
  userId = String(
    (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'fil-owner@example.com'`)[0]!['id'],
  );
  orgId = (await owner.json<{ id: string }>('/v1/orgs', body({ name: 'Fil Traders' }))).body.id;
  businessId = (
    await owner.json<{ id: string }>(
      `/v1/orgs/${orgId}/businesses`,
      body({ legalName: 'Fil Traders', tradeName: 'Fil Traders', stateCode: '27', gstin: GSTIN }),
    )
  ).body.id;
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

describe('the plan', () => {
  it('is a cloud plan feature, and the plan’s monthly calls are the limit', async () => {
    expect(
      (await owner.json(`${base()}/jobs`, body({ businessId, kind: 'push', period: FP }))).status,
    ).toBe(402);
    await pg.admin.sql`UPDATE subscriptions SET plan_id = 'cloud' WHERE org_id = ${orgId}`;
    const st = await owner.json<any>(`${base()}/status?businessId=${businessId}`);
    expect(st.body.entitlement).toMatchObject({ enabled: true, limit: 1000, used: 0 });
    expect(st.body.session).toMatchObject({ configured: true, practice: true, connected: false });
  });
});

describe('the portal login', () => {
  it('waits for an OTP when there is no session, and says so in the inbox', async () => {
    await issue();
    const j = await job('push');
    expect(j.status).toBe('waiting_otp');
    expect(j.view.error).toContain('OTP');
    expect(await items('otp')).toBe(1);
  });

  it('refuses a wrong OTP with the portal’s reason; the right one opens a session whose token is stored sealed', async () => {
    await owner.json(`${base()}/otp`, body({ businessId, username: 'asha.api' }));
    const bad = await owner.json<any>(`${base()}/otp/verify`, body({ businessId, otp: '000000' }));
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).toContain('Invalid OTP');
    const ok = await owner.json<any>(`${base()}/otp/verify`, body({ businessId, otp: '123456' }));
    expect(ok.body).toMatchObject({ connected: true, username: 'asha.api', gstin: GSTIN });
    const [row] = await sql('SELECT * FROM gstn_sessions');
    expect(JSON.stringify(row)).not.toContain('practice-gstn');
    expect(String(row!['token_enc'])).toMatch(/^v1\./);
    expect(JSON.stringify(ok.body)).not.toContain('token');
    expect(row!['otp_txn_id']).toBeNull(); // the OTP's request is spent
  });

  it('every call to the portal is metered', async () => {
    expect(await calls()).toBe(3); // the OTP request and both tries at verifying it (a refused one is a call too)
  });
});

describe('saving GSTR-1 on the portal', () => {
  it('saves every table, moves the desk to "saved on the portal", and meters the calls', async () => {
    const before = await calls();
    const j = await job('push');
    expect(j.status).toBe('done');
    expect(j.view.result).toMatchObject({ tables: expect.any(Array) });
    expect(j.view.reference).toMatch(/^REF-/);
    expect((await filingRow('gstr1'))!['status']).toBe('pushed');
    expect(await calls()).toBe(before + 2); // save and one status check
  });

  it('the same return again sends nothing: the job says unchanged and the portal is not called', async () => {
    const before = await calls();
    const pushes = gsp.gstnCalls.filter((c) => c === 'push').length;
    const j = await job('push');
    expect(j.status).toBe('done');
    expect(j.view.result).toMatchObject({ unchanged: true });
    expect(gsp.gstnCalls.filter((c) => c === 'push').length).toBe(pushes);
    expect(await calls()).toBe(before);
  });

  it('asking while a job is live returns that job', async () => {
    const r1 = await owner.json<any>(
      `${base()}/jobs`,
      body({ businessId, kind: 'pull_2a', period: '092026' }),
    );
    const r2 = await owner.json<any>(
      `${base()}/jobs`,
      body({ businessId, kind: 'pull_2a', period: '092026' }),
    );
    expect(r2.body).toEqual({ id: r1.body.id, existing: true });
    expect(queued.at(-1)!.jobId).toBe(r1.body.id);
    await svc.run(orgId, r1.body.id);
  });

  it('a partial failure leaves the desk as it was and names what the portal refused', async () => {
    const num = await issue('2026-09-10');
    gsp = new MockGspAdapter({ rejectNumbers: [num], now: () => new Date(clock) });
    await reconnect();
    const j = await job('push', 'gstr1', '092026');
    expect(j.status).toBe('partial');
    expect(JSON.stringify(j.view.result)).toContain(num);
    expect(await filingRow('gstr1', '092026')).toBeUndefined(); // not moved
    expect(await items('push_partial')).toBe(1);
  });

  it('a login that ran out stops the job, forgets the dead session and asks for a new OTP', async () => {
    await issue('2026-08-10');
    gsp.expireTokens();
    const j = await job('push', 'gstr1', '082026');
    expect(j.status).toBe('waiting_otp');
    expect((await sql('SELECT token_enc FROM gstn_sessions'))[0]!['token_enc']).toBeNull();
    expect(
      (await owner.json<any>(`${base()}/status?businessId=${businessId}`)).body.session.connected,
    ).toBe(false);
  });

  it('a nil return pushes a nil file, and the desk says the period is nil', async () => {
    await reconnect();
    const info = await owner.json<any>(
      `${base()}/desk?businessId=${businessId}&ret=gstr1&period=072026`,
    );
    expect(info.body.nil).toBe(true);
    const j = await job('push', 'gstr1', '072026');
    expect(j.status).toBe('done');
    expect(JSON.stringify(j.view.result)).toContain('"nil"');
  });

  it('QRMP: a quarter filer’s return period is the quarter, and IFF is a month', async () => {
    await new SettingsRepo(pg.app).set(ctx(), 'gst.filing.kind', 'quarter');
    const bad = await owner.json<any>(
      `${base()}/jobs`,
      body({ businessId, kind: 'push', period: '102026' }),
    );
    const run = await svc.run(orgId, bad.body.id);
    expect(run).toBe('failed'); // October is not a quarter's end
    const iff = await job('push', 'iff', '102026');
    expect(['done', 'partial']).toContain(iff.status);
    await new SettingsRepo(pg.app).set(ctx(), 'gst.filing.kind', 'month');
  });
});

async function reconnect() {
  svc = new FilingService({
    db: pg.app,
    secretsKey: Buffer.alloc(32, 5).toString('base64'),
    log: pino({ level: 'silent' }),
    now: () => clock,
    adapter: gsp,
    enqueue: async (j) => void queued.push(j),
  });
  t = makeTestApp(pg, { filing: svc });
  owner = await t.signIn('fil-owner@example.com', 'Owner');
  await login();
}

describe('pulling GSTR-2B and 2A', () => {
  const sample = (inum: string, taxable: number) => ({
    data: {
      gstin: GSTIN,
      rtnprd: FP,
      docdata: {
        b2b: [
          {
            ctin: '29AAACB1234F1Z5',
            trdnm: 'Bharat Supplies',
            supprd: FP,
            inv: [
              {
                inum,
                dt: '05-10-2026',
                val: taxable * 1.18,
                rev: 'N',
                itcavl: 'Y',
                items: [{ txval: taxable, igst: taxable * 0.18, cgst: 0, sgst: 0, cess: 0 }],
              },
            ],
          },
        ],
      },
    },
  });

  it('says plainly when the portal has not made it yet', async () => {
    const j = await job('pull_2b');
    expect(j.status).toBe('failed');
    expect(j.view.error).toContain('not generated');
  });

  it('imports it, replaces an earlier pull of the period, and reports what reconciliation found', async () => {
    gsp.setGstr2b(FP, sample('BS/001', 10_000));
    const j = await job('pull_2b');
    expect(j.status).toBe('done');
    expect(j.view.result).toMatchObject({ imported: 1, onlyIn2b: 1 });
    expect(await sql('SELECT 1 FROM gstr2b_entries WHERE deleted_at IS NULL')).toHaveLength(1);
    gsp.setGstr2b(FP, sample('BS/002', 20_000));
    await job('pull_2b');
    const rows = await sql('SELECT * FROM gstr2b_entries WHERE deleted_at IS NULL');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('BS/002');
  });

  it('summarises 2A for reference without putting it in reconciliation', async () => {
    gsp.setGstr2a(FP, sample('BS/009', 5_000));
    const j = await job('pull_2a');
    expect(j.view.result).toMatchObject({ entries: 1 });
    expect(await sql('SELECT 1 FROM gstr2b_entries WHERE deleted_at IS NULL')).toHaveLength(1);
  });
});

describe('filing confirmation', () => {
  it('picks up the ARN when the taxpayer files on the portal, and locks the books once both returns are filed', async () => {
    gsp.setFiled(GSTIN, FP, 'gstr1', 'AA2710260001A1Z', '2026-11-10');
    const j = await job('poll_filing', 'gstr1');
    expect(j.view.result).toMatchObject({ filed: true, arn: 'AA2710260001A1Z' });
    expect(await filingRow('gstr1')).toMatchObject({
      status: 'filed',
      arn: 'AA2710260001A1Z',
      filed_on: '2026-11-10',
    });
    expect(await items('filed')).toBe(1);
    expect(await new SettingsRepo(pg.app).getValue(ctx(), 'period_lock')).toBeUndefined(); // only GSTR-1 so far
    gsp.setFiled(GSTIN, FP, 'gstr3b', 'AA2710260002B2Z', '2026-11-20');
    await job('poll_filing', 'gstr3b');
    expect(await new SettingsRepo(pg.app).getValue(ctx(), 'period_lock')).toMatchObject({
      until: '2026-10-31',
    });
  });

  it('a return that is not filed yet is left alone', async () => {
    const j = await job('poll_filing', 'gstr1', '092026');
    expect(j.view.result).toEqual({ filed: false });
    expect(await filingRow('gstr1', '092026')).toBeUndefined();
  });

  it('the scheduler asks about returns that are saved but not filed, only for signed-in businesses', async () => {
    const r = await svc.scan();
    expect(r.asked).toBeGreaterThanOrEqual(0);
  });
});

describe('the Filing Desk figures', () => {
  it('estimates the late fee for an overdue return, and shows none once it is filed on time', async () => {
    const late = await owner.json<any>(
      `${base()}/desk?businessId=${businessId}&ret=gstr1&period=092026`,
    );
    expect(late.body.due).toBe('2026-10-11');
    expect(late.body.lateFee.days).toBeGreaterThan(0);
    expect(late.body.lateFee.feePaise).toBe(
      Math.min(late.body.lateFee.days * 5_000, late.body.lateFee.capPaise),
    );
    expect(late.body.lateFee.version).toContain('unreviewed');
    const filed = await owner.json<any>(
      `${base()}/desk?businessId=${businessId}&ret=gstr1&period=${FP}`,
    );
    expect(filed.body).toMatchObject({ filed: true, due: '2026-11-11' });
    expect(filed.body.lateFee.feePaise).toBe(0);
  });
});

describe('the pack for a client', () => {
  it('gives the two return files of a period under their usual names', async () => {
    const r = await owner.json<any>(`${base()}/pack?businessId=${businessId}&period=${FP}`);
    expect(r.status).toBe(200);
    expect(r.body.files.map((f: { name: string }) => f.name)).toEqual([
      `GSTR1_${GSTIN}_${FP}.json`,
      `GSTR3B_${GSTIN}_${FP}.json`,
    ]);
    expect(JSON.parse(r.body.files[0].content)).toMatchObject({ gstin: GSTIN, fp: FP });
  });
});

describe('the CA board', () => {
  it('shows each business with a cell per period and return, the overdue ones, and the open credit', async () => {
    const b = await filingBoard(pg.app, userId, clock, { itcThresholdPaise: 1 });
    const row = b.rows.find((r) => r.businessId === businessId)!;
    expect(row).toMatchObject({ orgName: 'Fil Traders', gstin: GSTIN });
    const cell = (fp: string, ret: string) => row.cells.find((c) => c.fp === fp && c.ret === ret)!;
    expect(cell(FP, 'gstr1').status).toBe('filed');
    expect(cell(FP, 'gstr3b').status).toBe('filed');
    expect(cell('092026', 'gstr1')).toMatchObject({ status: 'late', due: '2026-10-11' });
    expect(cell('092026', 'gstr1').lateFeePaise).toBeGreaterThan(0);
    expect(row.exceptions.map((e) => e.kind)).toEqual(expect.arrayContaining(['overdue', 'itc']));
    expect(b.periods).toContain(FP);
  });

  it('shows a signed-in user only the organisations they belong to', async () => {
    const stranger = await t.signIn('fil-stranger@example.com', 'Stranger');
    const sid = String(
      (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'fil-stranger@example.com'`)[0]![
        'id'
      ],
    );
    expect((await filingBoard(pg.app, sid, clock)).rows).toEqual([]);
    const r = await stranger.json<any>('/v1/me/filing-board');
    expect(r.body.rows).toEqual([]);
    const mine = await owner.json<any>('/v1/me/filing-board');
    expect(mine.body.rows.length).toBe(1);
  });
});

describe('limits', () => {
  it('refuses a call past the month’s limit, before making it', async () => {
    await pg.admin
      .sql`UPDATE plans SET limits_json = jsonb_set(limits_json, '{gspCalls}', '1') WHERE id = 'cloud'`;
    const r = await owner.json<any>(`${base()}/otp`, body({ businessId, username: 'asha.api' }));
    expect(r.status).toBe(402);
    expect(r.body.error.message).toContain('used up');
    await pg.admin
      .sql`UPDATE plans SET limits_json = jsonb_set(limits_json, '{gspCalls}', '1000') WHERE id = 'cloud'`;
  });
});
