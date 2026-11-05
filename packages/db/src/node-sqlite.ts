/**
 * A Node SQLite opener on the runtime's own `node:sqlite`, for code that must move database files
 * about (restoring over a file, the desktop sidecar). It closes properly: on Windows a file opened
 * with libsql stays locked after `close()` until the process ends, so it cannot be renamed.
 * Same schema, same repositories; the statement glue is the proxy the browser build uses.
 */
import { drizzle } from 'drizzle-orm/sqlite-proxy';

import type { Database } from './database';
import { buildSchema } from './schema';

type Method = 'run' | 'all' | 'values' | 'get';

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** SQLite through `node:sqlite`. Pass a file path, or nothing for a private in-memory database. */
export async function openNodeSqlite(file = ':memory:'): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  const run = (sqlText: string, params: unknown[], method: Method) => {
    const stmt = raw.prepare(sqlText);
    const bound = params.map((p) => (p === undefined ? null : p)) as never[];
    if (method === 'run') {
      stmt.run(...bound);
      return { rows: [] as unknown[][], columns: [] as string[] };
    }
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all(...bound) as unknown as unknown[][];
    return { rows: method === 'get' ? rows.slice(0, 1) : rows, columns };
  };
  const real = drizzle(async (sqlText, params, method) => {
    const r = run(sqlText, params, method);
    const rows = (method === 'get' ? (r.rows[0] ?? []) : r.rows) as unknown[];
    if (method !== 'get') Object.assign(rows, { columns: r.columns });
    return { rows };
  });
  const mutex = new Mutex();
  const db: any = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'transaction')
        return (fn: any, config?: any) => mutex.run(() => target.transaction(fn, config));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    dialect: 'sqlite',
    db,
    schema: buildSchema('sqlite'),
    close: async () => raw.close(),
  };
}
