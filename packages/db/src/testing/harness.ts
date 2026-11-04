import { execRaw, type Database } from '../database';
import { migrate } from '../migrate';
import { openPglite, openSqlite } from '../node';
import type { Dialect } from '../schema';

export const DIALECTS: Dialect[] = ['sqlite', 'pg'];

/**
 * Fresh migrated database per call. SQLite is in-memory; Postgres is PGlite (real Postgres in WASM,
 * no Docker needed). On Postgres, queries run as a non-superuser role so RLS is actually enforced.
 */
export async function openTestDb(dialect: Dialect): Promise<Database> {
  const d = dialect === 'sqlite' ? await openSqlite() : await openPglite();
  await migrate(d);
  if (dialect === 'pg') {
    for (const stmt of [
      'CREATE ROLE app_user NOLOGIN',
      'GRANT USAGE ON SCHEMA public TO app_user',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user',
      'SET ROLE app_user',
    ]) {
      await execRaw(d, d.db, stmt);
    }
  }
  return d;
}
