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
  directory?: string,
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

  const info = await call<OpenInfo>({ type: 'open', file, ...(directory ? { directory } : {}) });
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
 * Desktop: one SQLite connection owned by the Rust side (`apps/desktop/src-tauri/src/db.rs`). The
 * Tauri SQL plugin pools connections, so the `BEGIN` and `COMMIT` of a transaction issued as separate
 * calls could land on different ones; a single connection behind one command keeps the behaviour the
 * browser's worker has. `path` is the full path of the database file.
 */
export async function openTauriBackend(
  path: string,
  /** `main` is the live database; a restore builds its new one as `staging`. */
  id = 'main',
): Promise<{ backend: Backend; info: OpenInfo }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { decode, encode } = await import('@/features/desktop/codec');
  const version = await invoke<string>('db_open', { path, id });
  return {
    info: { persistent: true, version },
    backend: {
      async run(sql, params, method) {
        const r = await invoke<{ rows: unknown[][]; columns: string[] }>('db_exec', {
          sql,
          params: params.map(encode),
          method,
          id,
        });
        return { rows: r.rows.map((row) => row.map(decode)), columns: r.columns };
      },
      close: async () => {
        await invoke<null>('db_close', { id });
      },
    },
  };
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
