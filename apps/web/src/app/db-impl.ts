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

export interface OpenedDb {
  database: Database;
  persistent: boolean;
  reason?: string;
  kind: 'opfs' | 'memory' | 'tauri';
  schemaVersion: number;
}

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
  const {
    backend,
    info,
  }: { backend: Awaited<ReturnType<typeof openWorkerBackend>>['backend']; info: OpenInfo } = tauri
    ? await openTauriBackend(await desktopDbPath(loc))
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
    kind: tauri ? 'tauri' : info.persistent ? 'opfs' : 'memory',
    schemaVersion: await schemaVersion(database),
  };
}

export async function openAppDatabase(): Promise<OpenedDb> {
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
