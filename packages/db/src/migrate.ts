import { sql } from 'drizzle-orm';

import { execRaw, queryRows, type Database } from './database';
import { MIGRATIONS, type Migration } from './migrations.generated';
import { BREAK } from './schema/extras';

export { MIGRATIONS, type Migration };

const BOOTSTRAP =
  'CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY NOT NULL, value text NOT NULL)';

export interface MigrateOptions {
  migrations?: Migration[];
  /**
   * Called with the pending migration names before anything is applied.
   * Desktop uses this to take a backup (prompt 20). Throwing aborts the migration.
   */
  beforeMigrate?: (pending: string[]) => Promise<void>;
}

export interface MigrateResult {
  applied: string[];
  version: number;
}

/** Forward-only. Each migration runs in its own transaction and is recorded in `schema_meta`. */
export async function migrate(d: Database, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const all = opts.migrations ?? MIGRATIONS[d.dialect];
  await execRaw(d, d.db, BOOTSTRAP);

  const done = new Set(
    (await queryRows(d, d.db, sql`SELECT key FROM schema_meta WHERE key LIKE 'migration:%'`)).map(
      (r) => String(r['key']).slice('migration:'.length),
    ),
  );
  const pending = all.filter((m) => !done.has(m.name));
  if (pending.length > 0 && opts.beforeMigrate)
    await opts.beforeMigrate(pending.map((m) => m.name));

  let count = done.size;
  for (const m of pending) {
    await d.db.transaction(async (tx: any) => {
      for (const stmt of m.sql.split(BREAK)) {
        if (stmt.trim()) await execRaw(d, tx, stmt);
      }
      count += 1;
      await tx[d.dialect === 'sqlite' ? 'run' : 'execute'](
        sql`INSERT INTO schema_meta (key, value) VALUES (${'migration:' + m.name}, ${String(Date.now())})`,
      );
      await tx[d.dialect === 'sqlite' ? 'run' : 'execute'](
        sql`INSERT INTO schema_meta (key, value) VALUES ('version', ${String(count)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
    });
  }
  return { applied: pending.map((m) => m.name), version: count };
}

export async function schemaVersion(d: Database): Promise<number> {
  const rows = await queryRows(d, d.db, sql`SELECT value FROM schema_meta WHERE key = 'version'`);
  return rows[0] ? Number(rows[0]['value']) : 0;
}
