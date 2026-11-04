import { sql, type SQL } from 'drizzle-orm';

import { buildSchema, type Dialect, type Schema } from './schema';

/** A Drizzle database (libsql / Tauri-proxy SQLite, or Postgres) plus its compiled schema. */
export interface Database {
  readonly dialect: Dialect;
  /** Drizzle instance. Typed loosely on purpose: repositories are dialect-agnostic. */
  readonly db: any;
  readonly schema: Schema;
  close(): Promise<void>;
}

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

/** Run raw SQL text (no results). */
export async function execRaw(d: Database, tx: any, text: string): Promise<void> {
  if (d.dialect === 'sqlite') await tx.run(sql.raw(text));
  else await tx.execute(sql.raw(text));
}

/** Run a query and return rows as plain objects. */
export async function queryRows(d: Database, tx: any, q: SQL): Promise<Record<string, any>[]> {
  if (d.dialect === 'sqlite') return (await tx.all(q)) as Record<string, any>[];
  return (await tx.execute(q)).rows as Record<string, any>[];
}
