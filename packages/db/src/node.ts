/** Node-only database openers (libsql and PGlite). Not importable from browser code. */
import type { Database } from './database';
import { buildSchema } from './schema';

/** SQLite via libsql. Pass a file path (`file:app.db`) or `:memory:`. */
export async function openSqlite(url = ':memory:'): Promise<Database> {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const client = createClient({ url });
  await client.execute('PRAGMA foreign_keys = ON');
  const db = drizzle(client);
  return {
    dialect: 'sqlite',
    db,
    schema: buildSchema('sqlite'),
    close: async () => client.close(),
  };
}

/** Postgres via PGlite (real Postgres compiled to WASM). Pass a directory to persist. */
export async function openPglite(dataDir?: string): Promise<Database & { raw: any }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzle(client);
  return {
    dialect: 'pg',
    db,
    raw: client,
    schema: buildSchema('pg'),
    close: async () => client.close(),
  };
}

export * from './backup/node-files';
export * from './node-sqlite';
