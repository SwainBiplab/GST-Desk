/**
 * Drill: a database from the Phase 0 schema is migrated to the current one without losing anything.
 *
 * The Phase 0 database is built from the first migration plus the first set of search and guard
 * triggers (the schema the Phase 0 seed ran on), filled with rows by plain SQL, then taken to the
 * current schema with the real migration runner. Checked after: every row is still there with the same
 * values, the columns added since are there and empty, search finds the old rows (the search index
 * was rebuilt), the integrity and reference checks pass, a backup was taken first when asked, and the
 * database accepts new work. Running the migrations a second time does nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS,
  PartyRepo,
  ItemRepo,
  migrate,
  queryRows,
  schemaVersion,
  type Database,
} from '@gst/db';
import { openNodeSqlite } from '@gst/db/node';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'gst-drill-migrate-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file briefly */
  }
});

/** The migrations a Phase 0 database has: the first generated one and the first search and guard triggers. */
const PHASE_0 = MIGRATIONS.sqlite.filter(
  (m) => m.name.startsWith('0000_') || m.name === '9000_extras_v1',
);

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt: unknown;
  pk: number;
}

const columns = async (d: Database, table: string): Promise<Col[]> =>
  (await queryRows(d, d.db, sql.raw(`PRAGMA table_info(${table})`))).map((r) => ({
    name: String(r['name']),
    type: String(r['type']).toLowerCase(),
    notnull: Number(r['notnull']),
    dflt: r['dflt_value'],
    pk: Number(r['pk']),
  }));

let n = 0;
/** Insert one row using only the columns the Phase 0 schema requires, filling the rest from `over`. */
async function insert(d: Database, table: string, over: Record<string, unknown>): Promise<string> {
  const cols = await columns(d, table);
  const row: Record<string, unknown> = { ...over };
  for (const c of cols) {
    if (c.name in row) continue;
    if (c.notnull && c.dflt === null && !c.pk) {
      row[c.name] =
        c.name === 'id'
          ? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
          : c.type.includes('int')
            ? 1
            : 'x';
    }
  }
  if (!('id' in row)) row['id'] = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const names = Object.keys(row);
  await d.db.run(
    sql.raw(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names
        .map((k) => {
          const v = row[k];
          return typeof v === 'number'
            ? String(v)
            : v === null
              ? 'NULL'
              : `'${String(v).replace(/'/g, "''")}'`;
        })
        .join(', ')})`,
    ),
  );
  return String(row['id']);
}

describe('from the Phase 0 schema to the current one', () => {
  it('keeps every row, adds what is new, rebuilds search, and a second run does nothing', async () => {
    const file = join(dir, 'phase0.sqlite');
    const d = await openNodeSqlite(file);
    await migrate(d, { migrations: PHASE_0 });
    expect(await schemaVersion(d)).toBe(PHASE_0.length);

    // a small Phase 0 book, written by plain SQL because the current repositories know columns it does not have
    const org = await insert(d, 'organisations', { name: 'Old Org' });
    const business = await insert(d, 'businesses', {
      org_id: org,
      legal_name: 'Old Traders',
      state_code: '27',
    });
    const common = { org_id: org, business_id: business };
    const party = await insert(d, 'parties', {
      ...common,
      type: 'customer',
      name: 'Gopal Kirana',
      phone: '9820012345',
    });
    const item = await insert(d, 'items', { ...common, name: 'Green tea leaves', sku: 'OLD-1' });
    await insert(d, 'parties', { ...common, type: 'supplier', name: 'Sharma Traders' });
    await insert(d, 'items', { ...common, name: 'Copper wire', sku: 'OLD-2' });

    // the new work the later phases added is not there yet
    expect((await columns(d, 'parties')).map((c) => c.name)).not.toContain('language');
    expect((await columns(d, 'items')).map((c) => c.name)).not.toContain('name_latin');

    const before = {
      parties: (await queryRows(d, d.db, sql`SELECT id, name, phone FROM parties ORDER BY id`)).map(
        (r) => ({ ...r }),
      ),
      items: (await queryRows(d, d.db, sql`SELECT id, name, sku FROM items ORDER BY id`)).map(
        (r) => ({ ...r }),
      ),
    };

    // the real thing: a backup is asked for first, then every later migration runs
    let askedFor: string[] = [];
    const result = await migrate(d, {
      beforeMigrate: async (pending) => {
        askedFor = pending;
      },
    });
    expect(askedFor.length).toBeGreaterThan(0);
    expect(result.applied).toEqual(askedFor);
    expect(await schemaVersion(d)).toBe(MIGRATIONS.sqlite.length);

    // nothing lost, nothing changed
    expect(
      (await queryRows(d, d.db, sql`SELECT id, name, phone FROM parties ORDER BY id`)).map((r) => ({
        ...r,
      })),
    ).toEqual(before.parties);
    expect(
      (await queryRows(d, d.db, sql`SELECT id, name, sku FROM items ORDER BY id`)).map((r) => ({
        ...r,
      })),
    ).toEqual(before.items);

    // what is new is there, and empty for the old rows
    const pcols = (await columns(d, 'parties')).map((c) => c.name);
    expect(pcols).toEqual(expect.arrayContaining(['language', 'name_latin']));
    const [row] = await queryRows(
      d,
      d.db,
      sql`SELECT language, name_latin FROM parties WHERE id = ${party}`,
    );
    expect(row).toMatchObject({ language: null, name_latin: null });
    expect((await columns(d, 'review_items')).map((c) => c.name)).toEqual(
      expect.arrayContaining(['snoozed_until', 'dedupe_key']),
    );

    // search was rebuilt around the new column and still finds the old rows
    const ctx = { orgId: org, businessId: business, actor: 'drill', deviceId: 'drill' };
    expect((await new PartyRepo(d).search(ctx, 'gopal')).map((r) => r['id'])).toContain(party);
    expect((await new ItemRepo(d).search(ctx, 'green tea')).map((r) => r['id'])).toContain(item);

    // sound, and open for new work (a name in a native script found by its Roman key)
    expect(
      String((await queryRows(d, d.db, sql`PRAGMA integrity_check`))[0]!['integrity_check']),
    ).toBe('ok');
    expect((await queryRows(d, d.db, sql`PRAGMA foreign_key_check`)).length).toBe(0);
    const fresh = await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'शर्मा',
      name_latin: 'sharma stores',
      state_code: '27',
    });
    expect((await new PartyRepo(d).search(ctx, 'sharma stores')).map((r) => r['id'])).toContain(
      fresh['id'],
    );

    // a second run changes nothing
    expect((await migrate(d)).applied).toEqual([]);
    await d.close();
  });
});
