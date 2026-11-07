/**
 * Bring a Postgres database up to date: the shared schema first (`@gst/db` migrations, the same ones the
 * desktop and the browser run), then the API's own files (`migrations/*.sql`: auth tables, billing, the
 * app role), each recorded in `api_schema_meta` so a file runs once. Forward only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { migrate as migrateShared } from '@gst/db';

import type { PgDatabase } from './pool';

/** `apps/api/migrations` in development; `/app/migrations` in the image; or wherever API_MIGRATIONS_DIR says. */
export const API_MIGRATIONS_DIR =
  process.env['API_MIGRATIONS_DIR'] ?? join(process.cwd(), 'migrations');

export interface ApiMigrateResult {
  shared: number;
  api: string[];
}

export async function migrateApi(
  d: PgDatabase,
  opts: { appPassword?: string | undefined; dir?: string } = {},
): Promise<ApiMigrateResult> {
  const shared = await migrateShared(d);
  const sql = d.sql;
  await sql`CREATE TABLE IF NOT EXISTS api_schema_meta (name text PRIMARY KEY, applied_at bigint NOT NULL)`;
  const done = new Set(
    (await sql`SELECT name FROM api_schema_meta`).map((r) => r['name'] as string),
  );
  const dir = opts.dir ?? API_MIGRATIONS_DIR;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    const name = f.replace(/\.sql$/, '');
    if (done.has(name)) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      for (const stmt of text.split(/-->\s*statement-breakpoint\s*/)) {
        const s = stmt.trim();
        if (s) await tx.unsafe(s);
      }
      await tx`INSERT INTO api_schema_meta (name, applied_at) VALUES (${name}, ${Date.now()})`;
    });
    applied.push(name);
  }
  // the app role logs in only when the deployment gives it a password
  if (opts.appPassword) {
    await sql.unsafe(
      `ALTER ROLE gst_app WITH LOGIN PASSWORD '${opts.appPassword.replace(/'/g, "''")}'`,
    );
  }
  return { shared: shared.applied.length, api: applied };
}
