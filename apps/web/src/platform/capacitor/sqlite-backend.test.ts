import { describe, expect, it, vi } from 'vitest';

/** The native plugin stands in: what the adapter sends it, and how rows come back. */
const calls: { method: string; sql: string; values?: unknown[] | undefined }[] = [];
const conn = {
  open: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  execute: vi.fn(async (sql: string) => {
    calls.push({ method: 'execute', sql });
    return { changes: { changes: 0 } };
  }),
  run: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ method: 'run', sql, values });
    return { changes: { changes: 1 } };
  }),
  query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ method: 'query', sql, values });
    return sql.includes('empty')
      ? { values: [] }
      : { values: [{ id: 'a', total_paise: { $int: '9007199254740993' }, name: 'x' }] };
  }),
  getVersion: vi.fn(async () => ({ version: 3 })),
};
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    checkConnectionsConsistency = async () => ({ result: false });
    isConnection = async () => ({ result: false });
    retrieveConnection = async () => conn;
    createConnection = async () => conn;
    closeConnection = async () => undefined;
  },
}));

import { openCapacitorBackend } from './sqlite-backend';

describe('the phone’s SQLite adapter', () => {
  it('opens in WAL mode with foreign keys, runs writes and turns query rows into arrays with columns', async () => {
    const { backend, info } = await openCapacitorBackend('book.db');
    expect(info).toEqual({ persistent: true, version: '3' });
    expect(calls.slice(0, 2).map((c) => [c.method, c.sql])).toEqual([
      ['query', 'PRAGMA journal_mode = WAL'],
      ['execute', 'PRAGMA foreign_keys = ON'],
    ]);

    const w = await backend.run('INSERT INTO t VALUES (?, ?)', [1n, new Uint8Array([1, 2])], 'run');
    expect(w).toEqual({ rows: [], columns: [] });
    // bigints and bytes cross the bridge the way the desktop's do
    expect(calls.at(-1)?.values).toEqual([{ $int: '1' }, { $blob: 'AQI=' }]);

    const r = await backend.run('SELECT * FROM t', [], 'all');
    expect(r.columns).toEqual(['id', 'total_paise', 'name']);
    expect(r.rows).toEqual([['a', 9007199254740993n, 'x']]);
    expect(await backend.run('SELECT empty', [], 'get')).toEqual({ rows: [], columns: [] });

    await backend.close();
    expect(conn.close).toHaveBeenCalled();
  });
});
