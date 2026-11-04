/**
 * Used by scripts/verify-release.mjs: open a SQLite file created by a previous release, run the
 * current migrations on it, and print one JSON line with the outcome.
 *   tsx scripts/check-migrate.ts <db-file>
 */
import { sql } from 'drizzle-orm';

import { queryRows } from '../src/database';
import { migrate } from '../src/migrate';
import { openSqlite } from '../src/node';

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, error: 'usage: check-migrate.ts <db-file>' }));
  process.exit(2);
}

try {
  const d = await openSqlite(`file:${file}`);
  const { applied, version } = await migrate(d);
  const integrity = await queryRows(d, d.db, sql`PRAGMA integrity_check`);
  const fk = await queryRows(d, d.db, sql`PRAGMA foreign_key_check`);
  await d.close();
  const good = String(Object.values(integrity[0] ?? {})[0]) === 'ok' && fk.length === 0;
  console.log(
    JSON.stringify({
      ok: good,
      version,
      applied: applied.length,
      ...(good ? {} : { error: `integrity check failed (${fk.length} foreign key violations)` }),
    }),
  );
  process.exit(good ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}
