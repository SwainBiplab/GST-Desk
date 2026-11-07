/**
 * Heavy half of the database bootstrap (sqlite-wasm, drizzle, repositories). Loaded lazily by
 * `db.tsx` so the first paint never waits for it.
 */
import { buildSchema, migrate, schemaVersion, type Database } from '@gst/db';
import { queryRows } from '@gst/db';
import { sql } from 'drizzle-orm';

import {
  DEFAULT_LOCATION,
  activeLocation,
  confirmSwitch,
  revertSwitch,
  switchPending,
  type DbLocation,
} from './db-location';
import { isTauri, openTauriBackend, openWorkerBackend, type OpenInfo } from './sqlite/backends';
import { createDrizzle } from './sqlite/proxy';
import { deviceId } from './store';

import { readSession } from '@/features/cloud/client';
import { readCloudBook, type CloudBook } from '@/features/sync/book';
import { isNativeApp, platform } from '@/platform';
import type { NativeSyncedBook } from '@/platform/capacitor/synced-book';

export type DbKind = 'opfs' | 'memory' | 'tauri' | 'capacitor' | 'synced';

export interface OpenedDb {
  database: Database;
  persistent: boolean;
  reason?: string;
  kind: DbKind;
  schemaVersion: number;
  /** The sync client, when the book is a synced one (the phone app, prompt 43). */
  synced?: NativeSyncedBook;
  cloudBook?: CloudBook;
}

const local = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
};

/** Does this database hold anything worth protecting before it is changed? */
async function holdsData(database: Database): Promise<boolean> {
  try {
    const rows = await queryRows(database, database.db, sql`SELECT count(*) AS c FROM businesses`);
    return Number(rows[0]?.['c'] ?? 0) > 0;
  } catch {
    // the table is not there yet: a brand new database
    return false;
  }
}

/**
 * Where a location's database file is on disk. The default is the one in the data folder; a restore's
 * new copy sits in its own folder beside it, named like the browser's directory.
 */
export async function desktopDbPath(loc: DbLocation): Promise<string> {
  const { dataPaths, dirname } = await import('@/features/desktop/bridge');
  const live = (await dataPaths()).db;
  if (loc.dir === DEFAULT_LOCATION.dir && loc.file === DEFAULT_LOCATION.file) return live;
  return `${dirname(live)}/${loc.dir.replace(/^\//, '')}/${loc.file}`;
}

async function openAt(loc: DbLocation): Promise<OpenedDb> {
  const tauri = isTauri();
  const native = isNativeApp();
  const {
    backend,
    info,
  }: { backend: Awaited<ReturnType<typeof openWorkerBackend>>['backend']; info: OpenInfo } = tauri
    ? await openTauriBackend(await desktopDbPath(loc))
    : native
      ? await (await import('@/platform/capacitor/sqlite-backend')).openCapacitorBackend(loc.file)
      : await openWorkerBackend(loc.file, loc.dir);

  const database: Database = {
    dialect: 'sqlite',
    db: createDrizzle(backend),
    schema: buildSchema('sqlite'),
    close: () => backend.close(),
  };
  try {
    await migrate(database, {
      // before an update changes a database that holds data, keep a copy; if that cannot be done, the
      // update waits (the app says why) rather than changing data it could not take back
      beforeMigrate: async () => {
        if (!info.persistent || !(await holdsData(database))) return;
        const { preMigrationBackup } = await import('@/features/data/backup-service');
        await preMigrationBackup(database);
      },
    });
  } catch (e) {
    await database.close().catch(() => undefined);
    throw e;
  }
  return {
    database,
    persistent: info.persistent,
    ...(info.reason ? { reason: info.reason } : {}),
    kind: tauri ? 'tauri' : native ? 'capacitor' : info.persistent ? 'opfs' : 'memory',
    schemaVersion: await schemaVersion(database),
  };
}

/**
 * The phone app with a cloud business chosen opens that organisation's synced book: PowerSync over the
 * native SQLite, streaming the business down and this device's changes up. Without a session it opens
 * the local book instead (the account screen says sync is signed out).
 */
async function openSynced(book: CloudBook): Promise<OpenedDb | null> {
  const session = readSession(local.get);
  if (!session) return null;
  const { openNativeSyncedBook } = await import('@/platform/capacitor/synced-book');
  // an open that never answers (a plugin that is missing, a driver that waits for a worker) must say so
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('the synced book did not open in 90 seconds')), 90_000),
  );
  const synced = await Promise.race([
    openNativeSyncedBook({
      apiUrl: session.baseUrl,
      apiToken: session.token,
      orgId: book.orgId,
      deviceId: deviceId(),
      deviceName: `${platform()} phone`,
      platform: platform(),
    }),
    timeout,
  ]);
  return {
    database: synced.database,
    persistent: true,
    kind: 'synced',
    schemaVersion: await schemaVersion(synced.database),
    synced,
    cloudBook: book,
  };
}

export async function openAppDatabase(): Promise<OpenedDb> {
  const book = readCloudBook(local.get);
  if (book && isNativeApp()) {
    const opened = await openSynced(book);
    if (opened) return opened;
  }
  const loc = activeLocation();
  try {
    const opened = await openAt(loc);
    // a freshly restored copy that opens and migrates is now the database
    if (switchPending()) confirmSwitch();
    return opened;
  } catch (e) {
    // a restored copy that will not open: go back to the one before it, so nobody is locked out
    const back = revertSwitch();
    if (!back) throw e;
    return openAt(back);
  }
}
