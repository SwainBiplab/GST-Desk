/// <reference lib="webworker" />
/**
 * Dedicated worker that owns the SQLite connection (sqlite-wasm). Storage is OPFS via the
 * `opfs-sahpool` VFS, which needs no cross-origin isolation headers. If OPFS is unavailable (or another
 * tab holds the lock) it falls back to an in-memory database and reports `persistent: false`.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Method = 'run' | 'all' | 'values' | 'get';

type Req =
  | { id: number; type: 'open'; file: string }
  | { id: number; type: 'exec'; sql: string; params: unknown[]; method: Method }
  | { id: number; type: 'close' };

interface OpenResult {
  persistent: boolean;
  reason?: string;
  version: string;
}

let db: any = null;

async function open(file: string): Promise<OpenResult> {
  const sqlite3 = await sqlite3InitModule();
  let reason: string | undefined;
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: '/gst-desk', name: 'gst-opfs' });
    db = new pool.OpfsSAHPoolDb(`/${file}`);
    db.exec('PRAGMA foreign_keys = ON');
    return { persistent: true, version: sqlite3.version.libVersion };
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec('PRAGMA foreign_keys = ON');
  return { persistent: false, reason, version: sqlite3.version.libVersion };
}

function exec(sql: string, params: unknown[], method: Method) {
  if (method === 'run') {
    db.exec({ sql, bind: params as never });
    return { rows: [] as unknown[][], columns: [] as string[] };
  }
  const columns: string[] = [];
  const rows = db.exec({
    sql,
    bind: params as never,
    rowMode: 'array',
    returnValue: 'resultRows',
    columnNames: columns,
  }) as unknown[][];
  return { rows: method === 'get' ? rows.slice(0, 1) : rows, columns };
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    let result: unknown;
    if (req.type === 'open') result = await open(req.file);
    else if (req.type === 'exec') result = exec(req.sql, req.params, req.method);
    else {
      db?.close();
      db = null;
      result = null;
    }
    self.postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
