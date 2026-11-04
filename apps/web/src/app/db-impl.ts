/**
 * Heavy half of the database bootstrap (sqlite-wasm, drizzle, repositories). Loaded lazily by
 * `db.tsx` so the first paint never waits for it.
 */
import { buildSchema, migrate, schemaVersion, type Database } from '@gst/db';

import { isTauri, openTauriBackend, openWorkerBackend, type OpenInfo } from './sqlite/backends';
import { createDrizzle } from './sqlite/proxy';

export interface OpenedDb {
  database: Database;
  persistent: boolean;
  reason?: string;
  kind: 'opfs' | 'memory' | 'tauri';
  schemaVersion: number;
}

export async function openAppDatabase(file = 'gst-desk.sqlite3'): Promise<OpenedDb> {
  const tauri = isTauri();
  const {
    backend,
    info,
  }: { backend: Awaited<ReturnType<typeof openWorkerBackend>>['backend']; info: OpenInfo } = tauri
    ? await openTauriBackend(file)
    : await openWorkerBackend(file);

  const database: Database = {
    dialect: 'sqlite',
    db: createDrizzle(backend),
    schema: buildSchema('sqlite'),
    close: () => backend.close(),
  };
  await migrate(database);
  return {
    database,
    persistent: info.persistent,
    ...(info.reason ? { reason: info.reason } : {}),
    kind: tauri ? 'tauri' : info.persistent ? 'opfs' : 'memory',
    schemaVersion: await schemaVersion(database),
  };
}
