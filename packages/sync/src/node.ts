/**
 * A synced book in Node (the tests' devices, and a desktop or server-side helper): PowerSync's client
 * over Node's built-in SQLite, with our own schema as raw tables. The `Database` it returns is the one
 * every repository in `@gst/db` takes, so nothing in the repositories knows the book is synced.
 */
import { buildSchema, migrate, type Database } from '@gst/db';
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver';
import { PowerSyncDatabase, Schema } from '@powersync/node';

import { OUTCOMES_DDL, SyncConnector, type SyncIdentity, type UploadDb } from './connector';
import { UPLOADED, rawTables } from './tables';

export interface SyncedBook {
  ps: PowerSyncDatabase;
  database: Database;
  connector: SyncConnector;
  /** Start streaming and uploading. */
  connect(): Promise<void>;
  /** Stop both, keeping everything local (the book keeps working offline). */
  disconnect(): Promise<void>;
  close(): Promise<void>;
  /** Transactions waiting to upload. */
  pending(): Promise<number>;
}

export interface OpenOptions {
  /** Folder and file for this device's database. */
  dir: string;
  file?: string;
  identity: SyncIdentity;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  driver?: 'node:sqlite' | 'better-sqlite3';
}

const nodeMajor = () => Number(process.versions.node.split('.')[0]);

/**
 * The guards that stop a person's hard delete or an edit of the audit trail must not stop PowerSync: when
 * the server refuses something this device wrote, PowerSync puts the server's state back, which can mean
 * removing a row the device made. Each guard is rewritten to stand aside during a sync operation only.
 */
export async function relaxGuardsForSync(ps: {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<number> {
  const guards = await ps.getAll<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%' AND sql NOT LIKE '%powersync_in_sync_operation%'",
  );
  for (const g of guards) {
    const m = g.sql.match(
      /^([\s\S]*?\bON\s+\S+)(\s+FOR EACH ROW)?(\s+WHEN\s+([\s\S]*?))?\s+BEGIN\b([\s\S]*)$/i,
    );
    if (!m) continue;
    const when = m[4]
      ? `NOT powersync_in_sync_operation() AND (${m[4]})`
      : 'NOT powersync_in_sync_operation()';
    await ps.execute(`DROP TRIGGER IF EXISTS "${g.name}"`);
    await ps.execute(`${m[1]}${m[2] ?? ''} WHEN ${when} BEGIN${m[5]}`);
  }
  return guards.length;
}

export async function openSyncedBook(o: OpenOptions): Promise<SyncedBook> {
  const schema = new Schema({});
  schema.withRawTables(rawTables() as never);
  const ps = new PowerSyncDatabase({
    schema,
    database: {
      // PowerSync locks a database by its file name, so two books in one process need different names
      dbFilename: o.file ?? `book-${o.identity.deviceId}.db`,
      dbLocation: o.dir,
      // Node 24 can use its own SQLite (`node:sqlite`); before that, better-sqlite3
      implementation: { type: o.driver ?? (nodeMajor() >= 24 ? 'node:sqlite' : 'better-sqlite3') },
    },
  });
  await ps.init();

  const db = wrapPowerSyncWithDrizzle(ps);
  const database: Database = {
    dialect: 'sqlite',
    db,
    schema: buildSchema('sqlite'),
    close: () => ps.close(),
  };
  // the server is the source of truth and checks every reference; locally, rows arrive in the order the
  // stream sends them and people and organisations live only on the server, so references are not enforced
  await ps.execute('PRAGMA foreign_keys = OFF');
  await migrate(database);
  await ps.execute(OUTCOMES_DDL);
  await relaxGuardsForSync(ps);

  // local writes to synced tables go into PowerSync's upload queue (not while PowerSync itself writes)
  const raw = (schema.toJSON() as { raw_tables: { name: string }[] }).raw_tables;
  for (const t of raw) {
    if (!UPLOADED.has(t.name)) continue;
    for (const op of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const name = `${t.name}_ps_${op.toLowerCase()}`;
      await ps.execute(`DROP TRIGGER IF EXISTS "${name}"`);
      await ps.execute('SELECT powersync_create_raw_table_crud_trigger(?, ?, ?)', [
        JSON.stringify(t),
        name,
        op,
      ]);
    }
  }

  const connector = new SyncConnector(o.identity, o.fetchFn);
  const uploadDb: UploadDb = {
    getNextCrudTransaction: () => ps.getNextCrudTransaction(),
    execute: (sql, params) => ps.execute(sql, params as never[]),
    getOptional: (sql, params) => ps.getOptional(sql, params as never[]),
  };
  const psConnector = {
    fetchCredentials: () => connector.fetchCredentials(),
    uploadData: () => connector.uploadData(uploadDb),
  };

  return {
    ps,
    database,
    connector,
    connect: () => ps.connect(psConnector),
    disconnect: () => ps.disconnect(),
    close: () => ps.close(),
    pending: async () =>
      Number((await ps.get<{ n: number }>('SELECT count(DISTINCT tx_id) AS n FROM ps_crud')).n),
  };
}
