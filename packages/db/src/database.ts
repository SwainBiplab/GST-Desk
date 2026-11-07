import { sql, type SQL } from 'drizzle-orm';

import type { Dialect, Schema } from './schema';

/** A Drizzle database (libsql / Tauri-proxy SQLite, or Postgres) plus its compiled schema. */
export interface Database {
  readonly dialect: Dialect;
  /** Drizzle instance. Typed loosely on purpose: repositories are dialect-agnostic. */
  readonly db: any;
  readonly schema: Schema;
  close(): Promise<void>;
}

/** Run raw SQL text (no results). */
export async function execRaw(d: Database, tx: any, text: string): Promise<void> {
  if (d.dialect === 'sqlite') await tx.run(sql.raw(text));
  else await tx.execute(sql.raw(text));
}

/**
 * Run a query and return rows as plain objects. Some SQLite drivers (the browser and Tauri proxies)
 * return rows as arrays and attach `columns`; those are converted here.
 */
export async function queryRows(d: Database, tx: any, q: SQL): Promise<Record<string, any>[]> {
  if (d.dialect === 'sqlite') {
    const res = (await tx.all(q)) as any[] & { columns?: string[] };
    const columns = res.columns;
    if (columns && res.length > 0 && Array.isArray(res[0])) {
      return res.map((row: any[]) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    }
    return res as Record<string, any>[];
  }
  // PGlite answers `{ rows }`; postgres.js (the cloud API) answers the row list itself
  const res = await tx.execute(q);
  return (Array.isArray(res) ? res : res.rows) as Record<string, any>[];
}
