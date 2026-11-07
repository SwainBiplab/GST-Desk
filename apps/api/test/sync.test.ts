/**
 * Sync against the real PowerSync service (prompt 41): Postgres with logical replication, the service
 * streaming by the generated rules, devices that are real PowerSync clients over SQLite with our schema,
 * uploads through `/v1/sync/write`.
 */
import { DocumentFlowRepo, PartyRepo } from '@gst/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startSyncStack, type SyncStack } from './containers';
import {
  closeDevice,
  invoiceDraft,
  issueOn,
  makeSynced,
  openDevice,
  partyOn,
  serverRows,
  settled,
  toRows,
  until,
  type Device,
} from './sync-helper';

let stack: SyncStack;
let t: TestApp;
let owner: Client;
let orgId: string;
let businessId: string;
let userId: string;
const devices: Device[] = [];

beforeAll(async () => {
  stack = await startSyncStack();
  t = makeTestApp(stack, {
    env: { POWERSYNC_URL: stack.powersyncUrl, POWERSYNC_JWT_SECRET: stack.jwtSecret },
  });
  owner = await t.signIn('sync-owner@example.com');
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sync Traders' }),
    })
  ).body.id;
  businessId = (
    await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'Sync Traders', stateCode: '27' }),
    })
  ).body.id;
  userId = (await owner.json<{ user: { id: string } }>('/v1/me')).body.user.id;
  await makeSynced(stack, { orgId, businessId, actor: userId, deviceId: 'server' });
}, 300_000);

afterAll(async () => {
  for (const d of devices) await closeDevice(d);
  await stack?.stop();
});

describe('two devices on one business', () => {
  it('a new device downloads the business; a party made on one device reaches the server and the other device', async () => {
    const log = (m: string) => process.env['SYNC_DEBUG'] && console.log('STEP', m);
    const a = await openDevice(t, owner, orgId, businessId, userId, 'counter-a');
    log('a open');
    const b = await openDevice(t, owner, orgId, businessId, userId, 'counter-b');
    log('b open');
    devices.push(a, b);
    await a.book.connect();
    log('a connected');
    await b.book.connect();
    log('b connected');
    await settled(a);
    log('a settled');
    await settled(b);
    log('b settled');
    const biz = await a.book.ps.getAll<{ legal_name: string }>('SELECT legal_name FROM businesses');
    expect(biz.map((x) => x.legal_name)).toEqual(['Sync Traders']);
    const units = await a.book.ps.get<{ n: number }>(
      'SELECT count(*) AS n FROM units WHERE business_id = ?',
      [businessId],
    );
    expect(units.n).toBeGreaterThan(5);

    const party = await new PartyRepo(a.book.database).create(a.ctx, {
      type: 'customer',
      name: 'Ramesh Stores',
      state_code: '27',
      phone: '9876543210',
    });
    log('party made');
    await settled(a);
    log('a settled again');
    const [onServer] = await stack.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx`SELECT name, phone FROM parties WHERE id = ${party['id']}`;
    });
    expect(onServer).toMatchObject({ name: 'Ramesh Stores', phone: '9876543210' });
    await until(
      async () =>
        !!(await b.book.ps.getOptional('SELECT id FROM parties WHERE id = ?', [party['id']])),
      'the party on device b',
    );
    // and it is searchable on b: the row went into our own table, so the search triggers ran
    const found = await new PartyRepo(b.book.database).search(b.ctx, 'Ramesh', 5);
    expect(found.map((p) => p['id'])).toContain(party['id']);
  }, 180_000);
});

describe('numbers issued offline', () => {
  it('issues from its own range offline, then provisional numbers; on reconnect every number is real, unique and in order', async () => {
    const { ensureRanges } = await import('@gst/sync');
    const a = await openDevice(t, owner, orgId, businessId, userId, 'shop-a');
    const b = await openDevice(t, owner, orgId, businessId, userId, 'shop-b');
    devices.push(a, b);
    await a.book.connect();
    await b.book.connect();
    await settled(a);
    await settled(b);
    const custA = await partyOn(a, 'Walk-in A');
    const custB = await partyOn(b, 'Walk-in B');
    // each device takes a small block of numbers while online
    await ensureRanges(a.book.database, a.ctx, a.book.connector, '2026-06-01', {
      low: 3,
      size: 3,
      types: ['tax_invoice'],
    });
    await ensureRanges(b.book.database, b.ctx, b.book.connector, '2026-06-01', {
      low: 3,
      size: 3,
      types: ['tax_invoice'],
    });
    await settled(a);
    await settled(b);
    await until(
      async () =>
        Number(
          (
            await a.book.ps.get<{ n: number }>(
              'SELECT count(*) AS n FROM number_reservations WHERE device_id = ?',
              [a.deviceId],
            )
          ).n,
        ) === 1,
      'a range on a',
    );
    await until(
      async () =>
        Number(
          (
            await b.book.ps.get<{ n: number }>(
              'SELECT count(*) AS n FROM number_reservations WHERE device_id = ?',
              [b.deviceId],
            )
          ).n,
        ) === 1,
      'b range on b',
    );

    // a day offline: five invoices each, more than the block holds
    await a.book.disconnect();
    await b.book.disconnect();
    const made: { device: string; id: string; number: string }[] = [];
    for (let i = 0; i < 5; i++) {
      made.push({
        device: 'a',
        ...(await issueOn(a, invoiceDraft(custA, 'Walk-in A', '2026-06-02', 10_000n + BigInt(i)))),
      });
      made.push({
        device: 'b',
        ...(await issueOn(b, invoiceDraft(custB, 'Walk-in B', '2026-06-02', 20_000n + BigInt(i)))),
      });
    }
    const provisional = made.filter((m) => m.number.startsWith('PROV-'));
    expect(provisional.length).toBe(4); // 3 from each block, then 2 provisional each
    expect(new Set(made.map((m) => m.number)).size).toBe(10); // no two devices made the same one

    await a.book.connect();
    await b.book.connect();
    await settled(a);
    await settled(b);

    const docs = await serverRows(
      stack,
      orgId,
      "SELECT id, number, status FROM documents WHERE business_id = $1 AND type = 'tax_invoice' AND status = 'issued' ORDER BY number",
      [businessId],
    );
    expect(docs.length).toBe(10);
    expect(docs.every((d) => !String(d['number']).startsWith('PROV-'))).toBe(true);
    expect(new Set(docs.map((d) => d['number'])).size).toBe(10);
    const seq = docs
      .map((d) => Number(String(d['number']).match(/(\d+)$/)![1]))
      .sort((x, y) => x - y);
    expect(seq).toEqual(Array.from({ length: 10 }, (_, i) => seq[0]! + i)); // no gap
    // the swap is audited, and both devices end up with the real numbers
    const audits = await serverRows(
      stack,
      orgId,
      "SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'documents' AND after_json->>'reason' = 'number finalised on sync'",
    );
    expect(Number(audits[0]!['n'])).toBe(4);
    for (const dev of [a, b])
      await until(
        async () =>
          Number(
            (
              await dev.book.ps.get<{ n: number }>(
                "SELECT count(*) AS n FROM documents WHERE number LIKE 'PROV-%'",
              )
            ).n,
          ) === 0,
        'real numbers on the device',
      );
  }, 300_000);
});

describe('merges and conflicts', () => {
  let a: Device;
  let b: Device;
  const both = async () => {
    await a.book.connect();
    await settled(a);
    await b.book.connect();
    await settled(b);
    await settled(a);
  };

  beforeAll(async () => {
    a = await openDevice(t, owner, orgId, businessId, userId, 'merge-a');
    b = await openDevice(t, owner, orgId, businessId, userId, 'merge-b');
    devices.push(a, b);
    await both();
  }, 120_000);

  it('two devices change different details of one party offline: both changes are kept', async () => {
    const id = await partyOn(a, 'Gupta Traders');
    await both();
    await until(
      async () => !!(await b.book.ps.getOptional('SELECT id FROM parties WHERE id = ?', [id])),
      'party on b',
    );
    await a.book.disconnect();
    await b.book.disconnect();
    const pa = await new PartyRepo(a.book.database).get(a.ctx, id);
    await new PartyRepo(a.book.database).update(a.ctx, id, { phone: '9811111111' }, pa!['version']);
    const pb = await new PartyRepo(b.book.database).get(b.ctx, id);
    await new PartyRepo(b.book.database).update(
      b.ctx,
      id,
      { notes: 'pays on the 5th' },
      pb!['version'],
    );
    await both();
    const [server] = await serverRows(
      stack,
      orgId,
      'SELECT phone, notes FROM parties WHERE id = $1',
      [id],
    );
    expect(server).toMatchObject({ phone: '9811111111', notes: 'pays on the 5th' });
    for (const dev of [a, b])
      await until(async () => {
        const r = await dev.book.ps.getOptional<{ phone: string; notes: string }>(
          'SELECT phone, notes FROM parties WHERE id = ?',
          [id],
        );
        return r?.phone === '9811111111' && r?.notes === 'pays on the 5th';
      }, 'both details on the device');
  }, 180_000);

  it('two devices change the money of one draft offline: the first wins, the second becomes an inbox item with both versions', async () => {
    const cust = await partyOn(a, 'Draft Customer');
    const flow = new DocumentFlowRepo(a.book.database);
    const saved = await flow.saveDraft(
      a.ctx,
      toRows(invoiceDraft(cust, 'Draft Customer', '2026-06-10', 10_000n)),
    );
    const id = String(saved.document['id']);
    await both();
    await until(
      async () => !!(await b.book.ps.getOptional('SELECT id FROM documents WHERE id = ?', [id])),
      'draft on b',
    );
    await a.book.disconnect();
    await b.book.disconnect();
    const edit = async (dev: Device, rate: bigint) => {
      const f = new DocumentFlowRepo(dev.book.database);
      const cur = (await f.load(dev.ctx, id))!;
      await f.saveDraft(dev.ctx, {
        id,
        version: Number(cur.document['version']),
        ...toRows(invoiceDraft(cust, 'Draft Customer', '2026-06-10', rate)),
      });
    };
    await edit(a, 11_000n);
    await edit(b, 12_000n);
    await both();
    const [server] = await serverRows(
      stack,
      orgId,
      'SELECT total_taxable_paise FROM documents WHERE id = $1',
      [id],
    );
    expect(Number(server!['total_taxable_paise'])).toBe(22_000); // a's version (2 x 110.00)
    const conflicts = await serverRows(
      stack,
      orgId,
      "SELECT suggestion_json FROM review_items WHERE kind = 'sync_conflict' AND payload_json->>'rowId' = $1",
      [id],
    );
    expect(conflicts.length).toBe(1);
    const s = conflicts[0]!['suggestion_json'] as {
      mine: Record<string, unknown>;
      theirs: Record<string, unknown>;
      ops: unknown[];
    };
    expect(Number(s.theirs['total_taxable_paise'])).toBe(22_000);
    expect(Number(s.mine['total_taxable_paise'])).toBe(24_000); // b's edit is kept, not lost
    // b converges to the server's draft: its own new lines arrive deleted, the old ones come back
    await until(async () => {
      const d = await b.book.ps.getOptional<{ t: number }>(
        'SELECT total_taxable_paise AS t FROM documents WHERE id = ?',
        [id],
      );
      const lines = await b.book.ps.getAll<{ r: number }>(
        'SELECT rate_paise AS r FROM document_lines WHERE document_id = ? AND deleted_at IS NULL',
        [id],
      );
      return Number(d?.t) === 22_000 && lines.length === 1 && Number(lines[0]!.r) === 11_000;
    }, 'b to show the server draft');
    // and the conflict is in b's inbox, from the stream
    await until(
      async () =>
        Number(
          (
            await b.book.ps.get<{ n: number }>(
              "SELECT count(*) AS n FROM review_items WHERE kind = 'sync_conflict' AND status = 'pending'",
            )
          ).n,
        ) >= 1,
      'the conflict in the inbox',
    );
  }, 180_000);

  it('a delete made earlier loses to an edit made later on another device', async () => {
    const cust = await partyOn(a, 'Delete Race');
    const flow = new DocumentFlowRepo(a.book.database);
    const saved = await flow.saveDraft(
      a.ctx,
      toRows(invoiceDraft(cust, 'Delete Race', '2026-06-11', 5_000n)),
    );
    const id = String(saved.document['id']);
    await both();
    await until(
      async () => !!(await b.book.ps.getOptional('SELECT id FROM documents WHERE id = ?', [id])),
      'draft on b',
    );
    await a.book.disconnect();
    await b.book.disconnect();
    // a deletes first
    const cur = (await flow.load(a.ctx, id))!;
    await new DocumentFlowRepo(a.book.database).discardDraft(
      a.ctx,
      id,
      Number(cur.document['version']),
    );
    await new Promise((r) => setTimeout(r, 20));
    // b edits a moment later (notes only) and reaches the server first
    const fb = new DocumentFlowRepo(b.book.database);
    const curB = (await fb.load(b.ctx, id))!;
    await fb.saveDraft(b.ctx, {
      id,
      version: Number(curB.document['version']),
      ...toRows(invoiceDraft(cust, 'Delete Race', '2026-06-11', 5_000n, 'deliver Monday')),
    });
    await b.book.connect();
    await settled(b);
    await a.book.connect();
    await settled(a);
    const [server] = await serverRows(
      stack,
      orgId,
      'SELECT deleted_at, notes FROM documents WHERE id = $1',
      [id],
    );
    expect(server!['deleted_at']).toBeNull();
    const conflicts = await serverRows(
      stack,
      orgId,
      "SELECT suggestion_json->>'reason' AS reason FROM review_items WHERE kind = 'sync_conflict' AND payload_json->>'rowId' = $1",
      [id],
    );
    expect(conflicts.map((c) => c['reason'])).toEqual([
      'deleted here, but edited later on another device',
    ]);
  }, 180_000);

  it('a device that changes a total without the lines is refused, and gets the true total back', async () => {
    const cust = await partyOn(a, 'Tamper Test');
    const { id } = await issueOn(a, invoiceDraft(cust, 'Tamper Test', '2026-06-12', 7_000n));
    await settled(a);
    const [before] = await serverRows(
      stack,
      orgId,
      'SELECT total_paise FROM documents WHERE id = $1',
      [id],
    );
    await a.book.ps.execute(
      'UPDATE documents SET total_paise = 1, version = version + 1 WHERE id = ?',
      [id],
    );
    await settled(a);
    const [after] = await serverRows(
      stack,
      orgId,
      'SELECT total_paise FROM documents WHERE id = $1',
      [id],
    );
    expect(after!['total_paise']).toEqual(before!['total_paise']);
    const out = await a.book.ps.getAll<{ outcome: string; reason: string }>(
      "SELECT outcome, reason FROM sync_outcomes WHERE outcome = 'rejected' ORDER BY at DESC LIMIT 1",
    );
    expect(out[0]?.reason).toMatch(
      /issued document changes only through a revision|totals do not match/,
    );
    await until(
      async () =>
        Number(
          (
            await a.book.ps.get<{ t: number }>(
              'SELECT total_paise AS t FROM documents WHERE id = ?',
              [id],
            )
          ).t,
        ) === Number(before!['total_paise']),
      'the true total back on the device',
    );
  }, 180_000);
});

describe('local to synced and back', () => {
  it('converts a local book (the 500-document demo) to synced, a second device gets all of it, and detaching gives a standalone copy', async () => {
    const { uploadBusiness, detachBusiness } = await import('@gst/sync');
    const { openTestDb } = await import('@gst/db/testing');
    const { seedDemo } = await import('@gst/db/seed');
    const { NumberingRepo } = await import('@gst/db');
    const local = await openTestDb('sqlite');
    const seeded = await seedDemo(local);
    const bizId = seeded.ctx.businessId;

    const up = await openDevice(t, owner, orgId, bizId, userId, 'converter');
    devices.push(up);
    const copied = await uploadBusiness(
      local,
      seeded.ctx,
      {
        database: up.book.database,
        writeTransaction: (fn) => up.book.ps.writeTransaction(fn as never),
      },
      { orgId, deviceId: up.deviceId, actor: userId },
    );
    expect(copied.tables['documents']).toBe(500);
    await up.book.connect();
    await settled(up);

    const count = async (where: Device | 'server', table: string) =>
      where === 'server'
        ? Number(
            (
              await serverRows(
                stack,
                orgId,
                `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`,
                [bizId],
              )
            )[0]!['n'],
          )
        : Number(
            (
              await where.book.ps.get<{ n: number }>(
                `SELECT count(*) AS n FROM ${table} WHERE business_id = ?`,
                [bizId],
              )
            ).n,
          );
    const outcomes = await up.book.ps.getAll<{ outcome: string; reason: string | null }>(
      "SELECT outcome, reason FROM sync_outcomes WHERE outcome <> 'applied'",
    );
    expect(outcomes).toEqual([]);
    for (const table of [
      'parties',
      'items',
      'documents',
      'document_lines',
      'payments',
      'ledger_entries',
    ])
      expect({ table, n: await count('server', table) }).toEqual({
        table,
        n: copied.tables[table] ?? 0,
      });
    // numbers and counters came across as they were
    const [maxNo] = await serverRows(
      stack,
      orgId,
      "SELECT count(DISTINCT number)::int AS n FROM documents WHERE business_id = $1 AND status <> 'draft'",
      [bizId],
    );
    const localIssued = await local.db.all(
      `SELECT count(DISTINCT number) AS n FROM documents WHERE business_id = '${bizId}' AND status <> 'draft'`,
    );
    expect(Number(maxNo!['n'])).toBe(Number((localIssued as { n: number }[])[0]!.n));

    const other = await openDevice(t, owner, orgId, bizId, userId, 'second-device');
    devices.push(other);
    const t0 = performance.now();
    await other.book.connect();
    await settled(other);
    await until(
      async () =>
        (await count(other, 'documents')) === 500 &&
        (await count(other, 'document_lines')) === copied.tables['document_lines'],
      'the whole book on the second device',
    );
    const seconds = (performance.now() - t0) / 1000;
    // what came down the wire, for the initial-sync budget (50,000 documents in 2 minutes at 20 Mbps)
    const rows = await other.book.ps.get<{ n: number; bytes: number }>(
      'SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes FROM ps_oplog',
    );
    const { gzipSync } = await import('node:zlib');
    const all = await other.book.ps.getAll<{ row_type: string; data: string }>(
      'SELECT row_type, data FROM ps_oplog',
    );
    const gz = gzipSync(Buffer.from(all.map((r) => r.data ?? '').join('\n'))).length;
    const byType = new Map<string, number>();
    for (const r of all)
      byType.set(r.row_type, (byType.get(r.row_type) ?? 0) + (r.data?.length ?? 0));
    console.log(
      'INITIAL-SYNC by table',
      JSON.stringify([...byType.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)),
      'gzip',
      gz,
    );
    const perDoc = rows.bytes / 500;
    const at20Mbps = (perDoc * 50_000 * 8) / 20e6;
    const perDocGz = gz / 500;
    console.log(
      `INITIAL-SYNC gzip ${(perDocGz / 1024).toFixed(1)} KB per document; 50,000 at 20 Mbps: ${((perDocGz * 50_000 * 8) / 20e6).toFixed(0)} s`,
    );
    console.log(
      `INITIAL-SYNC 500 documents (${rows.n} rows, ${(rows.bytes / 1e6).toFixed(2)} MB) in ${seconds.toFixed(1)} s locally; ${(perDoc / 1024).toFixed(1)} KB per document with its lines, ledger and stock rows; 50,000 documents at 20 Mbps: ${at20Mbps.toFixed(0)} s of transfer`,
    );
    expect(await new NumberingRepo(other.book.database).getMode(other.ctx)).toBe('synced');

    const standalone = await openTestDb('sqlite');
    const back = await detachBusiness(other.book.database, other.ctx, standalone, 'Sync Traders');
    expect(back.tables['documents']).toBe(500);
    expect(await new NumberingRepo(standalone).getMode(other.ctx)).toBe('local');
    await standalone.close();
    await local.close();
  }, 300_000);
});
