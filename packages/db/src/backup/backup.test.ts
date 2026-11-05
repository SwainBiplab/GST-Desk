import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryRows, type Database } from '../database';
import { MIGRATIONS, migrate, schemaVersion } from '../migrate';
import { openSqlite } from '../node';
import {
  AttachmentRepo,
  PartyRepo,
  SettingsRepo,
  createOrganisation,
} from '../repositories/aggregates';
import { type Ctx } from '../repositories/base';
import { REPORT_IDS, REPORTS, runReport } from '../repositories/reports';
import { seedDemo } from '../seed';
import { openTestDb } from '../testing/harness';

import {
  BackupError,
  TABLES,
  backupFileName,
  backupKindOf,
  backupTimeOf,
  exportSchemaDoc,
  businessDataFromBackup,
  createBackup,
  exportBusinessJson,
  exportCsvBundle,
  importBusinessData,
  parseExportJson,
  preflightBackup,
  readManifest,
  readTable,
  restoreAll,
  sha256Hex,
  tableOrder,
  toPortable,
  verifyBackup,
} from './index';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});
const fresh = async () => {
  const d = await openTestDb('sqlite');
  opened.push(d);
  return d;
};

/** Every row of every table, as portable values, in key order. */
async function snapshot(d: Database): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) {
    const rows: Record<string, unknown>[] = [];
    for await (const chunk of readTable(d, t.name, 2000))
      rows.push(...chunk.map((r) => toPortable(t, r)));
    out[t.name] = rows;
  }
  return out;
}

const rewrite = (bytes: Uint8Array, fn: (files: Record<string, Uint8Array>) => void) => {
  const files = unzipSync(bytes);
  fn(files);
  return zipSync(files);
};
const rewriteManifest = (bytes: Uint8Array, fn: (m: Record<string, unknown>) => void) =>
  rewrite(bytes, (files) => {
    const m = JSON.parse(strFromU8(files['manifest.json']!)) as Record<string, unknown>;
    fn(m);
    files['manifest.json'] = strToU8(JSON.stringify(m));
  });

const png = (n: number) => new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * n + 7) % 256));

describe('the backup file', () => {
  let a: Database;
  let ctx: Ctx;
  let bytes: Uint8Array;
  let blobs: Map<string, Uint8Array>;
  let secretValue: string;

  beforeAll(async () => {
    a = await fresh();
    ({ ctx } = await seedDemo(a, { documents: 250, parties: 25, items: 50 }));
    blobs = new Map();
    const logo = png(3);
    const sha = await sha256Hex(logo);
    blobs.set(`opfs:${sha}`, logo);
    const parties = await new PartyRepo(a).list(ctx, { limit: 2 });
    const att = new AttachmentRepo(a);
    await att.register(ctx, {
      ownerTable: 'parties',
      ownerId: String(parties[0]!['id']),
      fileName: 'logo.png',
      mime: 'image/png',
      sizeBytes: logo.length,
      sha256: sha,
      storagePath: `opfs:${sha}`,
    });
    // the same bytes attached to a second owner are stored once
    await att.register(ctx, {
      ownerTable: 'parties',
      ownerId: String(parties[1]!['id']),
      fileName: 'logo-copy.png',
      mime: 'image/png',
      sizeBytes: logo.length,
      sha256: sha,
      storagePath: `opfs:${sha}`,
    });
    const settings = new SettingsRepo(a);
    await settings.set(ctx, 'reports.views', [
      { id: 'v1', name: 'Mine', search: { party: String(parties[0]!['id']) } },
    ]);
    secretValue = 'ya29.SECRET-ACCESS-TOKEN';
    await settings.set(ctx, 'cloud.token.google', secretValue);
    await settings.set(ctx, 'oauth.refresh', 'refresh-secret');
    await settings.set(ctx, 'pin', '4821');
    ({ bytes } = await createBackup(a, {
      attachments: { read: async (p) => blobs.get(p) ?? null },
    }));
  }, 120_000);

  it('lists every table with its row count, size and checksum, and checks out', async () => {
    const m = readManifest(bytes);
    expect(m.format).toBe('gstbk');
    expect(m.schemaVersion).toBe(await schemaVersion(a));
    expect(Object.keys(m.tables).sort()).toEqual(TABLES.map((t) => t.name).sort());
    for (const t of TABLES) {
      const n = Number(
        (await queryRows(a, a.db, sql`SELECT count(*) AS c FROM ${sql.identifier(t.name)}`))[0]![
          'c'
        ],
      );
      const skippedSecrets = t.name === 'settings' ? 3 : 0;
      expect(m.tables[t.name]!.rows, t.name).toBe(n - skippedSecrets);
      expect(m.tables[t.name]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(m.totals.rows).toBe(Object.values(m.tables).reduce((s, t) => s + t.rows, 0));
    expect(m.businesses).toHaveLength(1);
    expect(m.businesses[0]).toMatchObject({
      legalName: 'Demo Traders Pvt Ltd',
      tradeName: 'Demo Traders',
    });
    const v = await verifyBackup(bytes);
    expect(v.problems).toEqual([]);
  });

  it('keeps each attached file once, named by its hash', async () => {
    const m = readManifest(bytes);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.file).toBe(`attachments/${m.attachments[0]!.sha256}`);
    expect(m.missingAttachments).toEqual([]);
    expect(m.tables['attachments']!.rows).toBe(2);
  });

  it('leaves out tokens, credentials and PINs, but keeps ordinary settings', async () => {
    const files = unzipSync(bytes);
    const settings = strFromU8(files['data/settings.jsonl']!);
    expect(settings).toContain('reports.views');
    for (const secret of [
      'cloud.token.google',
      'oauth.refresh',
      'pin',
      secretValue,
      'refresh-secret',
      '4821',
    ])
      expect(settings).not.toContain(secret);
    // and nowhere else in the archive either
    for (const [name, data] of Object.entries(files)) {
      if (name.startsWith('attachments/')) continue;
      expect(strFromU8(data), name).not.toContain(secretValue);
    }
  });

  it('restores into an empty database and every table matches row for row', async () => {
    const b = await fresh();
    const out = await restoreAll(b, bytes, { attachments: { write: async () => undefined } });
    expect(out.rows).toBe(readManifest(bytes).totals.rows);
    const before = await snapshot(a);
    const after = await snapshot(b);
    for (const t of TABLES) {
      const expected =
        t.name === 'settings'
          ? before[t.name]!.filter((r) => !/^(cloud\.token|oauth|pin)/.test(String(r['key'])))
          : before[t.name]!;
      expect(after[t.name], t.name).toEqual(expected);
    }
  }, 120_000);

  it('a fresh install restored from a backup gives the same reports, stock and ledger', async () => {
    const b = await fresh();
    await restoreAll(b, bytes);
    const range = { from: '2024-04-01', to: '2026-03-31', today: '2026-03-31' };
    for (const id of REPORT_IDS) {
      const page = REPORTS[id].paged ? { offset: 0, limit: 5000 } : undefined;
      const x = await runReport(a, ctx, id, range, page);
      const y = await runReport(b, ctx, id, range, page);
      expect(y, id).toEqual(x);
    }
    const sums = async (d: Database) =>
      queryRows(
        d,
        d.db,
        sql`SELECT account_id, sum(debit_paise) AS dr, sum(credit_paise) AS cr FROM ledger_entries GROUP BY account_id ORDER BY account_id`,
      );
    expect(await sums(b)).toEqual(await sums(a));
    const stock = async (d: Database) =>
      queryRows(
        d,
        d.db,
        sql`SELECT item_id, sum(qty_micros) AS q FROM stock_movements GROUP BY item_id ORDER BY item_id`,
      );
    expect(await stock(b)).toEqual(await stock(a));
    // search works again: the index is rebuilt by the inserts
    const hit = await queryRows(
      b,
      b.db,
      sql`SELECT count(*) AS c FROM parties_fts WHERE parties_fts MATCH 'sharma*'`,
    );
    const was = await queryRows(
      a,
      a.db,
      sql`SELECT count(*) AS c FROM parties_fts WHERE parties_fts MATCH 'sharma*'`,
    );
    expect(hit[0]!['c']).toEqual(was[0]!['c']);
  }, 180_000);

  it('refuses to restore over data in use', async () => {
    const err = await restoreAll(a, bytes).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).code).toBe('target_not_empty');
  });

  it('refuses a file that is not a backup, a damaged one, and one that was cut short', async () => {
    const b = await fresh();
    const junk = new Uint8Array(500).map((_, i) => (i * 31) % 251);
    await expect(restoreAll(b, junk)).rejects.toMatchObject({ code: 'not_a_backup' });
    await expect(restoreAll(b, strToU8('hello'))).rejects.toMatchObject({ code: 'not_a_backup' });
    const noManifest = zipSync({ 'readme.txt': strToU8('hi') });
    await expect(restoreAll(b, noManifest)).rejects.toMatchObject({ code: 'not_a_backup' });

    // one table file changed after the backup was made: its checksum no longer matches
    const tampered = rewrite(bytes, (files) => {
      const text = strFromU8(files['data/parties.jsonl']!);
      files['data/parties.jsonl'] = strToU8(text.replace('"Sharma', '"Sharmx'));
    });
    const pre = await preflightBackup(tampered, await schemaVersion(b));
    expect(pre.ok).toBe(false);
    expect(pre.problems.join(' ')).toMatch(/parties.*checksum/);
    await expect(restoreAll(b, tampered)).rejects.toMatchObject({ code: 'corrupt' });

    // a file left out of the archive
    const missing = rewrite(bytes, (files) => {
      delete files['data/documents.jsonl'];
    });
    await expect(restoreAll(b, missing)).rejects.toMatchObject({ code: 'corrupt' });
    // an attachment that no longer matches its hash
    const badFile = rewrite(bytes, (files) => {
      const name = Object.keys(files).find((n) => n.startsWith('attachments/'))!;
      files[name] = png(9);
    });
    expect((await preflightBackup(badFile, await schemaVersion(b))).ok).toBe(false);
    // none of these touched the database
    const orgs = await queryRows(b, b.db, sql`SELECT count(*) AS c FROM organisations`);
    expect(Number(orgs[0]!['c'])).toBe(0);
  });

  it('refuses a backup from a newer app, and one in a format it does not know', async () => {
    const b = await fresh();
    const now = await schemaVersion(b);
    const newer = rewriteManifest(bytes, (m) => (m['schemaVersion'] = now + 1));
    const pre = await preflightBackup(newer, now);
    expect(pre).toMatchObject({ ok: false, newerThanApp: true });
    await expect(restoreAll(b, newer)).rejects.toMatchObject({ code: 'newer_schema' });
    const future = rewriteManifest(bytes, (m) => (m['formatVersion'] = 99));
    await expect(restoreAll(b, future)).rejects.toMatchObject({ code: 'unsupported_version' });
  });

  it('is all or nothing: a failure part way leaves the database empty', async () => {
    const b = await fresh();
    let seen = 0;
    const err = await restoreAll(b, bytes, {
      onBatch: (table) => {
        seen += 1;
        if (table === 'document_lines') throw new Error('power cut');
      },
    }).catch((e) => e);
    expect(err.message).toBe('power cut');
    expect(seen).toBeGreaterThan(3);
    for (const t of TABLES) {
      const r = await queryRows(b, b.db, sql`SELECT count(*) AS c FROM ${sql.identifier(t.name)}`);
      expect(Number(r[0]!['c']), t.name).toBe(0);
    }
    // and the same database restores fine afterwards
    await restoreAll(b, bytes);
    const r = await queryRows(b, b.db, sql`SELECT count(*) AS c FROM documents`);
    expect(Number(r[0]!['c'])).toBeGreaterThan(200);
  }, 120_000);

  it('hands each attached file to the sink under its hash, once', async () => {
    const b = await fresh();
    const got: [string, number][] = [];
    await restoreAll(b, bytes, {
      attachments: { write: async (sha, data) => void got.push([sha, data.length]) },
    });
    expect(got).toEqual([[await sha256Hex(png(3)), 64]]);
  });

  it('records a file it could not read, or that did not match its hash, instead of failing', async () => {
    const wrong = await createBackup(a, { attachments: { read: async () => png(5) } });
    expect(wrong.manifest.attachments).toEqual([]);
    expect(wrong.manifest.missingAttachments).toHaveLength(1);
    const none = await createBackup(a, { attachments: { read: async () => null } });
    expect(none.manifest.missingAttachments).toHaveLength(1);
    expect((await verifyBackup(none.bytes)).warnings.join(' ')).toMatch(/could not be copied/);
    // without a reader at all the rows are still backed up
    const bare = await createBackup(a);
    expect(bare.manifest.totals.rows).toBe(readManifest(bytes).totals.rows);
  });

  it('knows its tables: parents come before the rows that point at them', () => {
    const order = tableOrder();
    expect(new Set(order).size).toBe(TABLES.length);
    for (const t of TABLES)
      for (const parent of Object.values(t.refs))
        if (parent !== t.name)
          expect(order.indexOf(parent), `${parent} before ${t.name}`).toBeLessThan(
            order.indexOf(t.name),
          );
  });

  it('reports progress and gives the page room to breathe between chunks', async () => {
    const stages = new Set<string>();
    let yields = 0;
    await createBackup(a, {
      chunkRows: 50,
      onProgress: (p) => stages.add(p.stage),
      yieldToUi: async () => void (yields += 1),
    });
    expect(stages.has('documents')).toBe(true);
    expect(yields).toBeGreaterThan(20);
  });
});

describe('export and import of one business', () => {
  let a: Database;
  let ctx: Ctx;
  let json: string;
  let fullBackup: Uint8Array;

  beforeAll(async () => {
    a = await fresh();
    ({ ctx } = await seedDemo(a, { documents: 200, parties: 20, items: 40 }));
    const parties = await new PartyRepo(a).list(ctx, { limit: 1 });
    const settings = new SettingsRepo(a);
    await settings.set(ctx, 'reports.views', [
      { id: 'v1', name: 'Mine', search: { party: String(parties[0]!['id']) } },
    ]);
    await settings.set(ctx, 'cloud.token.google', 'SECRET');
    json = await exportBusinessJson(a, ctx.businessId);
    ({ bytes: fullBackup } = await createBackup(a));
  }, 120_000);

  const target = async () => {
    const b = await fresh();
    const org = await createOrganisation(b, 'Second install');
    return { b, org: String(org['id']), actor: 'someone-else' };
  };
  const stripIds = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stripIds)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => k !== 'id')
              .map(([k, x]) => [k, stripIds(x)]),
          )
        : v;

  it('exports one JSON document: documents carry their lines, nothing secret', () => {
    const doc = JSON.parse(json) as {
      format: string;
      business: { id: string };
      tables: Record<string, any[]>;
    };
    expect(doc.format).toBe('gst-desk-export');
    expect(doc.business.id).toBe(ctx.businessId);
    expect(doc.tables['documents']!.length).toBe(200);
    expect(doc.tables['documents']![0]!.lines.length).toBeGreaterThan(0);
    expect(doc.tables['document_lines']).toBeUndefined();
    expect(doc.tables['audit_log']).toBeUndefined();
    expect(doc.tables['users']).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('cloud.token');
    expect(JSON.stringify(doc)).not.toContain('SECRET');
  });

  it('imports it as a new business with new ids, and its reports match the original', async () => {
    const { b, org, actor } = await target();
    const r = await importBusinessData(b, parseExportJson(json), { orgId: org, actor });
    expect(r.dryRun).toBe(false);
    expect(r.businessId).not.toBe(ctx.businessId);
    expect(r.tables['documents']).toBe(200);
    expect(r.tables['businesses']).toBe(1);

    const nctx: Ctx = { orgId: org, businessId: r.businessId, actor, deviceId: 'd' };
    const range = { from: '2024-04-01', to: '2026-03-31', today: '2026-03-31' };
    for (const id of REPORT_IDS) {
      const page = REPORTS[id].paged ? { offset: 0, limit: 5000 } : undefined;
      const x = await runReport(a, ctx, id, range, page);
      const y = await runReport(b, nctx, id, range, page);
      // rows that tie on date and time are ordered by id, which is new: compare them as a set
      const sortRows = (r: typeof x) => ({
        ...r,
        rows: [...r.rows].sort((p, q) =>
          JSON.stringify(stripIds(p)).localeCompare(JSON.stringify(stripIds(q))),
        ),
      });
      expect(stripIds(sortRows(y)), id).toEqual(stripIds(sortRows(x)));
    }
    // no id was kept
    const oldIds = new Set<string>();
    for await (const c of readTable(a, 'documents', 2000))
      for (const row of c) oldIds.add(String(row['id']));
    for await (const c of readTable(b, 'documents', 2000))
      for (const row of c) expect(oldIds.has(String(row['id']))).toBe(false);
    // the new business owns its rows, which were stamped with the person importing
    const stamped = await queryRows(b, b.db, sql`SELECT DISTINCT created_by AS c FROM documents`);
    expect(stamped).toEqual([{ c: actor }]);
    const orgs = await queryRows(b, b.db, sql`SELECT DISTINCT org_id AS o FROM documents`);
    expect(orgs).toEqual([{ o: org }]);
    // every reference points inside the new business
    const lost = await queryRows(
      b,
      b.db,
      sql`SELECT count(*) AS c FROM document_lines l LEFT JOIN documents d ON d.id = l.document_id WHERE d.id IS NULL OR d.business_id <> l.business_id`,
    );
    expect(Number(lost[0]!['c'])).toBe(0);
    const fk = await queryRows(b, b.db, sql`PRAGMA foreign_key_check`);
    expect(fk).toEqual([]);
  }, 120_000);

  it('follows ids kept inside settings to the new ids', async () => {
    const { b, org, actor } = await target();
    const r = await importBusinessData(b, parseExportJson(json), { orgId: org, actor });
    const nctx: Ctx = { orgId: org, businessId: r.businessId, actor, deviceId: 'd' };
    const views = await new SettingsRepo(b).getValue<{ search: { party: string } }[]>(
      nctx,
      'reports.views',
    );
    const partyId = views![0]!.search.party;
    const found = await queryRows(
      b,
      b.db,
      sql`SELECT business_id AS b FROM parties WHERE id = ${partyId}`,
    );
    expect(found).toEqual([{ b: r.businessId }]);
    expect(await new SettingsRepo(b).getValue(nctx, 'cloud.token.google')).toBeUndefined();
  });

  it('a dry run counts exactly what a real import writes, and writes nothing', async () => {
    const { b, org, actor } = await target();
    const dry = await importBusinessData(b, parseExportJson(json), {
      orgId: org,
      actor,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    for (const t of TABLES) {
      const r = await queryRows(b, b.db, sql`SELECT count(*) AS c FROM ${sql.identifier(t.name)}`);
      expect(Number(r[0]!['c']), t.name).toBe(t.name === 'organisations' ? 1 : 0);
    }
    const real = await importBusinessData(b, parseExportJson(json), { orgId: org, actor });
    expect(real.tables).toEqual(dry.tables);
    expect(real.rows).toBe(dry.rows);
    // and a second import is a second business
    const again = await importBusinessData(b, parseExportJson(json), {
      orgId: org,
      actor,
      name: 'Copy',
    });
    expect(again.businessId).not.toBe(real.businessId);
    const names = await queryRows(
      b,
      b.db,
      sql`SELECT legal_name FROM businesses ORDER BY legal_name`,
    );
    expect(names.map((n) => n['legal_name'])).toEqual(['Copy', 'Demo Traders Pvt Ltd (imported)']);
  }, 120_000);

  it('restores one business from a full backup as a new business', async () => {
    const { b, org, actor } = await target();
    const v = { manifest: readManifest(fullBackup) };
    const data = businessDataFromBackup(fullBackup, v, ctx.businessId);
    const r = await importBusinessData(b, data, { orgId: org, actor });
    expect(r.tables['documents']).toBe(200);
    expect(r.tables['stock_movements']).toBeGreaterThan(50);
    expect(() => businessDataFromBackup(fullBackup, v, crypto.randomUUID())).toThrow(BackupError);
  }, 120_000);

  it('rejects what is not an export, and an export from a newer app', () => {
    expect(() => parseExportJson('not json')).toThrow(BackupError);
    expect(() => parseExportJson('{"format":"other"}')).toThrow(BackupError);
    const future = JSON.stringify({ ...JSON.parse(json), formatVersion: 99 });
    expect(() => parseExportJson(future)).toThrow(/newer version/);
  });

  it('stops, and writes nothing, when the data points at something that is not there', async () => {
    const { b, org, actor } = await target();
    const data = parseExportJson(json);
    data.tables['document_lines']![0]!['document_id'] = crypto.randomUUID();
    await expect(importBusinessData(b, data, { orgId: org, actor })).rejects.toBeInstanceOf(
      BackupError,
    );
    const r = await queryRows(b, b.db, sql`SELECT count(*) AS c FROM businesses`);
    expect(Number(r[0]!['c'])).toBe(0);
  });

  it('writes a CSV bundle: every table with all its columns, text a spreadsheet will not run, and the files', async () => {
    await new PartyRepo(a).create(ctx, {
      type: 'customer',
      name: '=HYPERLINK("http://x")',
      state_code: '27',
    });
    const logo = png(8);
    const sha = await sha256Hex(logo);
    await new AttachmentRepo(a).register(ctx, {
      ownerTable: 'businesses',
      ownerId: ctx.businessId,
      fileName: 'my logo.png',
      mime: 'image/png',
      sizeBytes: logo.length,
      sha256: sha,
      storagePath: `opfs:${sha}`,
    });
    const zip = await exportCsvBundle(a, ctx.businessId, {
      attachments: { read: async (p) => (p === `opfs:${sha}` ? logo : null) },
    });
    const files = unzipSync(zip);
    const csvBytes = files['documents.csv']!;
    // Excel needs the byte order mark to read Indian names; the decoder drops it, the bytes keep it
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const docs = strFromU8(csvBytes).split('\r\n').filter(Boolean);
    expect(docs[0]!.split(',')).toEqual(
      Object.keys(TABLES.find((t) => t.name === 'documents')!.columns),
    );
    expect(docs.length).toBe(1 + 200);
    expect(strFromU8(files['parties.csv']!)).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(Object.keys(files).some((n) => /^attachments\/[0-9a-f]{12}-my_logo\.png$/.test(n))).toBe(
      true,
    );
    expect(strFromU8(files['settings.csv']!)).not.toContain('cloud.token');
    expect(files['README.txt']).toBeDefined();
    expect(JSON.parse(strFromU8(files['counts.json']!)).rows.documents).toBe(200);
  }, 120_000);
});

describe('the pre-migration backup hook', () => {
  it('backs up before migrating, and the backup restores into a database at the old schema', async () => {
    const all = MIGRATIONS.sqlite;
    const older = all.slice(0, -1);
    // not the test harness, which migrates fully: this database starts one migration behind
    const d = await openSqlite();
    opened.push(d);
    await migrate(d, { migrations: older });
    const org = await createOrganisation(d, 'Org');
    const ctx0: Ctx = { orgId: String(org['id']), businessId: '', actor: 't', deviceId: 'd' };
    const { BusinessRepo } = await import('../repositories/aggregates');
    const biz = await new BusinessRepo(d).create(ctx0, { legal_name: 'Before', state_code: '27' });
    const ctx = { ...ctx0, businessId: String(biz['id']) };
    await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Kept safe', state_code: '27' });

    let taken: Uint8Array | null = null;
    let pending: string[] = [];
    const result = await migrate(d, {
      migrations: all,
      beforeMigrate: async (names) => {
        pending = names;
        taken = (await createBackup(d)).bytes;
      },
    });
    expect(pending).toEqual([all[all.length - 1]!.name]);
    expect(result.applied).toEqual(pending);
    expect(taken).not.toBeNull();

    // the backup holds what was there before the migration, and restores at the version it was made at
    const old = await openSqlite();
    opened.push(old);
    await migrate(old, { migrations: older });
    await restoreAll(old, taken!);
    const kept = await queryRows(old, old.db, sql`SELECT name FROM parties`);
    expect(kept).toEqual([{ name: 'Kept safe' }]);
    // and a hook that throws stops the migration
    const stopped = await openSqlite();
    opened.push(stopped);
    await migrate(stopped, { migrations: older });
    await expect(
      migrate(stopped, {
        migrations: all,
        beforeMigrate: async () => {
          throw new Error('backup failed');
        },
      }),
    ).rejects.toThrow('backup failed');
    expect(await schemaVersion(stopped)).toBe(older.length);
  }, 120_000);
});

describe('backup file names', () => {
  it('say what made the backup and when, and read back to the same moment', () => {
    const at = new Date(Date.UTC(2025, 2, 1, 9, 30, 5));
    for (const kind of ['auto', 'manual', 'pre-migration'] as const) {
      const name = backupFileName(at, kind);
      expect(name).toBe(`${kind}-20250301T093005Z.gstbk`);
      expect(backupKindOf(name)).toBe(kind);
      expect(backupTimeOf(name)?.getTime()).toBe(at.getTime());
    }
    // names sort by time, so a list of them is in order
    const names = [3, 1, 2].map((d) => backupFileName(new Date(Date.UTC(2025, 0, d)), 'auto'));
    expect([...names].sort()).toEqual([names[1], names[2], names[0]]);
  });

  it('ignores files that are not backups', () => {
    for (const name of [
      'notes.txt',
      '20250301T093005Z.gstbk',
      'auto-2025.gstbk',
      'auto-20251301T093005Z.GSTBK',
    ]) {
      expect(backupTimeOf(name) === null || name.endsWith('.GSTBK')).toBe(true);
      expect(backupKindOf(name)).toBeNull();
    }
  });
});

describe('docs/export-schema.md', () => {
  it('is what the schema says: rewrite it with `pnpm --filter @gst/db docs:export-schema` after a schema change', () => {
    const file = join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'export-schema.md');
    expect(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).toBe(exportSchemaDoc());
  });

  it('describes every table and column, and names the secrets it leaves out', () => {
    const doc = exportSchemaDoc();
    for (const t of TABLES) {
      expect(doc).toContain(`### \`${t.name}\``);
      for (const c of Object.keys(t.columns)) expect(doc).toContain(`| \`${c}\` |`);
    }
    expect(doc).toContain('cloud.credentials');
    expect(doc).toContain('paise');
  });
});
