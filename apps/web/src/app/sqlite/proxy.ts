/**
 * Drizzle `sqlite-proxy` glue shared by the browser (sqlite-wasm worker) and desktop (Tauri SQL plugin)
 * back ends. A backend only has to run one statement and return rows plus column names.
 */
import { drizzle } from 'drizzle-orm/sqlite-proxy';

export type Method = 'run' | 'all' | 'values' | 'get';

export interface StatementResult {
  rows: unknown[][];
  columns: string[];
}

export interface Backend {
  run(sql: string, params: unknown[], method: Method): Promise<StatementResult>;
  close(): Promise<void>;
}

/** Serialises transactions: one connection must not interleave two BEGIN...COMMIT blocks. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function createDrizzle(backend: Backend): any {
  const real = drizzle(async (sql, params, method) => {
    const r = await backend.run(sql, params, method);
    // `columns` rides along so raw queries (db.all(sql`...`)) can be turned back into objects
    const rows = (method === 'get' ? (r.rows[0] ?? []) : r.rows) as unknown[];
    if (method !== 'get') Object.assign(rows, { columns: r.columns });
    return { rows };
  });
  const mutex = new Mutex();
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (fn: any, config?: any) => mutex.run(() => target.transaction(fn, config));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
