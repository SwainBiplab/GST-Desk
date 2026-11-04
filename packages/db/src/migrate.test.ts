import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { queryRows, type Database } from './database';
import { MIGRATIONS, migrate, schemaVersion } from './migrate';
import { openPglite, openSqlite } from './node';
import { SPEC } from './schema';
import * as pgEntry from './schema/pg';
import * as sqliteEntry from './schema/sqlite';

describe('schema entrypoints', () => {
  it('export every spec table for Drizzle Kit', () => {
    const names = SPEC.map((s) => s.name).sort();
    expect(Object.keys(sqliteEntry).sort()).toEqual(names);
    expect(Object.keys(pgEntry).sort()).toEqual(names);
  });
});

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

describe.each([
  ['sqlite', () => openSqlite()],
  ['pg', () => openPglite()],
] as const)('migrate (%s)', (dialect, open) => {
  it('goes from empty to v1 and is idempotent', async () => {
    const d = await open();
    opened.push(d);
    const first = await migrate(d);
    expect(first.applied).toEqual(MIGRATIONS[dialect].map((m) => m.name));
    expect(first.version).toBe(MIGRATIONS[dialect].length);
    expect(await schemaVersion(d)).toBe(first.version);

    const second = await migrate(d);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(first.version);

    const tables =
      dialect === 'sqlite'
        ? await queryRows(d, d.db, sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        : await queryRows(
            d,
            d.db,
            sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
          );
    const have = new Set(tables.map((t) => t['name']));
    for (const s of SPEC) expect(have.has(s.name), s.name).toBe(true);
    expect(have.has('schema_meta')).toBe(true);
  });

  it('calls the beforeMigrate hook with pending names', async () => {
    const d = await open();
    opened.push(d);
    let seen: string[] = [];
    await migrate(d, { beforeMigrate: async (p) => void (seen = p) });
    expect(seen).toEqual(MIGRATIONS[dialect].map((m) => m.name));
    seen = ['untouched'];
    await migrate(d, { beforeMigrate: async (p) => void (seen = p) });
    expect(seen).toEqual(['untouched']);
  });
});
