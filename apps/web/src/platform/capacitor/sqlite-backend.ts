/**
 * A local book on the phone (prompt 43): SQLite through the Capacitor community plugin, one native
 * connection behind the same `Backend` the browser's worker and the desktop's Rust side implement, so
 * every repository runs unchanged. Values cross the bridge the way the desktop encodes them.
 */
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

import type { OpenInfo } from '@/app/sqlite/backends';
import type { Backend, Method, StatementResult } from '@/app/sqlite/proxy';
import { decode, encode } from '@/features/desktop/codec';

const sqlite = new SQLiteConnection(CapacitorSQLite);

export async function openCapacitorBackend(
  file: string,
): Promise<{ backend: Backend; info: OpenInfo }> {
  const name = file.replace(/\.db$/, '');
  // after a reload of the page the native side may still hold the connection: take it up again
  const consistent = (await sqlite.checkConnectionsConsistency()).result ?? false;
  const held = consistent && ((await sqlite.isConnection(name, false)).result ?? false);
  const db = held
    ? await sqlite.retrieveConnection(name, false)
    : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  await db.open();
  // a pragma that answers is a query to the plugin
  await db.query('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON', false);
  const version = String((await db.getVersion()).version ?? '');

  const run = async (sql: string, params: unknown[], method: Method): Promise<StatementResult> => {
    const values = params.map(encode);
    if (method === 'run') {
      await db.run(sql, values, false);
      return { rows: [], columns: [] };
    }
    const r = await db.query(sql, values);
    const found = (r.values ?? []) as Record<string, unknown>[];
    const columns = found.length ? Object.keys(found[0]!) : [];
    return { rows: found.map((row) => columns.map((c) => decode(row[c]))), columns };
  };
  return {
    info: { persistent: true, version },
    backend: {
      run,
      close: async () => {
        await db.close().catch(() => undefined);
        await sqlite.closeConnection(name, false).catch(() => undefined);
      },
    },
  };
}
