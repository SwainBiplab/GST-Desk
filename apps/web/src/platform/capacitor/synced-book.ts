/**
 * A synced book on the phone (prompt 43): PowerSync's Capacitor client over the native SQLite, with
 * our own schema as raw tables, the same way the Node opener does it (`@gst/sync/node`). The phone is
 * the first app platform that runs the sync client; the browser build still has none (B-167).
 */
import { Capacitor } from '@capacitor/core';
import { buildSchema, migrate, type Database } from '@gst/db';
import {
  OUTCOMES_DDL,
  SyncConnector,
  UPLOADED,
  rawTables,
  relaxGuardsForSync,
  type SyncIdentity,
  type UploadDb,
} from '@gst/sync';
import { PowerSyncDatabase } from '@powersync/capacitor';
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver';
import { Schema } from '@powersync/web';

/** PowerSync's query result shape, built from rows the adapter's write path would have dropped. */
const asResult = (rows: Record<string, unknown>[]) => ({
  rowsAffected: 0,
  rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
});
const RETURNING = /\breturning\b/i;

interface Ctx {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  executeRaw(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
type LockFn = (fn: (ctx: Ctx) => Promise<unknown>, o?: unknown) => Promise<unknown>;

/** `DBAdapter`'s `TransactionImplementation.runWith`, with the lock's context answering every query. */
async function runTransaction(ctx: Ctx, fn: (tx: Ctx) => Promise<unknown>): Promise<unknown> {
  let finalized = false;
  const tx = Object.create(ctx as object, {
    commit: {
      value: async () => {
        if (finalized) return;
        finalized = true;
        await ctx.execute('COMMIT');
      },
    },
    rollback: {
      value: async () => {
        if (finalized) return;
        finalized = true;
        await ctx.execute('ROLLBACK');
      },
    },
  }) as Ctx & { commit(): Promise<void>; rollback(): Promise<void> };
  await ctx.execute('BEGIN IMMEDIATE');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    finalized = true;
    await ctx.execute('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/**
 * On Android the Capacitor adapter runs anything that is not a SELECT through `executeSet`, which
 * answers with no rows, so the `INSERT ... RETURNING` every repository relies on comes back empty. A
 * statement that returns rows is sent down the query path instead (a raw query on the same write
 * connection, inside the same lock), which executes it and gives the rows. iOS needs none of this.
 */
function withReturning<T extends Ctx>(target: T, locks = true): T {
  if (Capacitor.getPlatform() !== 'android') return target;
  return new Proxy(target, {
    get(t, p, r) {
      if (p === 'execute')
        return (sql: string, params?: unknown[]) =>
          RETURNING.test(sql)
            ? t.getAll<Record<string, unknown>>(sql, params).then(asResult)
            : t.execute(sql, params);
      if (p === 'executeRaw')
        return (sql: string, params?: unknown[]) =>
          RETURNING.test(sql)
            ? t.getAll<Record<string, unknown>>(sql, params).then((rows) => ({
                rowsAffected: 0,
                columnNames: Object.keys(rows[0] ?? {}),
                rawRows: rows.map((x) => Object.values(x)),
              }))
            : t.executeRaw(sql, params);
      if (locks && (p === 'writeLock' || p === 'readLock')) {
        const orig = Reflect.get(t, p, r) as LockFn;
        return (fn: (ctx: Ctx) => Promise<unknown>, o?: unknown) =>
          orig.call(t, (ctx: Ctx) => fn(withReturning(ctx, false)), o);
      }
      if (locks && (p === 'writeTransaction' || p === 'readTransaction')) {
        // the SDK's own transaction object answers getAll through executeRaw, which loses the rows on
        // Android; this one runs the same BEGIN IMMEDIATE, COMMIT and ROLLBACK and asks the lock's own
        // context, which keeps them
        const lock = Reflect.get(
          t,
          p === 'writeTransaction' ? 'writeLock' : 'readLock',
          r,
        ) as LockFn;
        return (fn: (tx: Ctx) => Promise<unknown>, o?: unknown) =>
          lock.call(t, (ctx: Ctx) => runTransaction(withReturning(ctx, false), fn), o);
      }
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

export interface NativeSyncedBook {
  ps: PowerSyncDatabase;
  database: Database;
  connector: SyncConnector;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
  pending(): Promise<number>;
}

export async function openNativeSyncedBook(identity: SyncIdentity): Promise<NativeSyncedBook> {
  const schema = new Schema({});
  schema.withRawTables(rawTables() as never);
  const ps = new PowerSyncDatabase({
    schema,
    // the Capacitor client picks the native SQLite driver on a phone; the web client's shared worker
    // and multi-tab coordination have no place in a WebView (and would wait for a SharedWorker forever)
    database: {
      dbFilename: `book-${identity.orgId}.db`,
      enableMultiTabs: false,
      useWebWorker: false,
    },
  });
  console.info('synced book: opening');
  await ps.init();
  console.info('synced book: database open');

  const database: Database = {
    dialect: 'sqlite',
    db: wrapPowerSyncWithDrizzle(withReturning(ps) as never),
    schema: buildSchema('sqlite'),
    close: () => ps.close(),
  };
  await ps.execute('PRAGMA foreign_keys = OFF');
  await migrate(database);
  await ps.execute(OUTCOMES_DDL);
  await relaxGuardsForSync(ps);
  console.info('synced book: schema ready');
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

  const connector = new SyncConnector(identity);
  const uploadDb: UploadDb = {
    getNextCrudTransaction: () => ps.getNextCrudTransaction(),
    execute: (sql, params) => ps.execute(sql, params as never[]),
    getOptional: (sql, params) => ps.getOptional(sql, params as never[]),
  };
  const psConnector = {
    fetchCredentials: () => connector.fetchCredentials(),
    uploadData: () => connector.uploadData(uploadDb),
  };
  const book: NativeSyncedBook = {
    ps,
    database,
    connector,
    connect: () => ps.connect(psConnector),
    disconnect: () => ps.disconnect(),
    close: () => ps.close(),
    pending: async () =>
      Number((await ps.get<{ n: number }>('SELECT count(DISTINCT tx_id) AS n FROM ps_crud')).n),
  };
  // `localStorage.gst.debug = 1` puts the book on the window for the device matrix's remote console
  try {
    if (localStorage.getItem('gst.debug') === '1')
      (globalThis as { __gstSyncedBook?: NativeSyncedBook }).__gstSyncedBook = book;
  } catch {
    /* storage blocked */
  }
  return book;
}
