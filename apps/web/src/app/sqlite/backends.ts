import type { Backend, Method, StatementResult } from './proxy';

export interface OpenInfo {
  persistent: boolean;
  /** Why storage fell back to memory, if it did. */
  reason?: string;
  version: string;
}

/** Browser: sqlite-wasm in a dedicated worker. */
export async function openWorkerBackend(
  file: string,
): Promise<{ backend: Backend; info: OpenInfo }> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

  worker.onmessage = (
    e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>,
  ) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.resolve(e.data.result as never);
    else w.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'database worker crashed'));
    waiting.clear();
  };

  const call = <T>(msg: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      worker.postMessage({ id, ...msg });
    });

  const info = await call<OpenInfo>({ type: 'open', file });
  return {
    info,
    backend: {
      run: (sql: string, params: unknown[], method: Method) =>
        call<StatementResult>({ type: 'exec', sql, params, method }),
      close: async () => {
        await call({ type: 'close' });
        worker.terminate();
      },
    },
  };
}

/**
 * Desktop: Tauri SQL plugin. NOT YET VERIFIED: the plugin pools connections, so BEGIN/COMMIT issued as
 * separate calls may not share one connection. Prompt 23 (desktop packaging) replaces this with a
 * single-connection Rust command before the desktop app ships.
 */
export async function openTauriBackend(
  file: string,
): Promise<{ backend: Backend; info: OpenInfo }> {
  const { default: Database } = await import('@tauri-apps/plugin-sql');
  const conn = await Database.load(`sqlite:${file}`);
  await conn.execute('PRAGMA foreign_keys = ON');
  return {
    info: { persistent: true, version: 'tauri-sql' },
    backend: {
      async run(sql, params, method) {
        if (method === 'run') {
          await conn.execute(sql, params);
          return { rows: [], columns: [] };
        }
        const objs = await conn.select<Record<string, unknown>[]>(sql, params);
        const columns = objs[0] ? Object.keys(objs[0]) : [];
        const rows = objs.map((o) => columns.map((c) => o[c]));
        return { rows: method === 'get' ? rows.slice(0, 1) : rows, columns };
      },
      close: () => conn.close().then(() => undefined),
    },
  };
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
