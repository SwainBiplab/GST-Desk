/**
 * The sidecar runtime: a llama.cpp, whisper.cpp or OCR server started on demand, used one request at a
 * time, and stopped when nothing has asked for it for a while. The process itself is started by the
 * desktop (`SidecarRuntime`); this file only decides when.
 */

export type SidecarKind = 'llama' | 'whisper' | 'ocr';

export interface SidecarHandle {
  baseUrl: string;
}

export interface SidecarRuntime {
  /** Start (or return the running) server for a model file. Resolves when it answers `/health`. */
  start(kind: SidecarKind, args: { modelFile: string; threads?: number }): Promise<SidecarHandle>;
  stop(kind: SidecarKind): Promise<void>;
}

export interface Keeper {
  /** Run `fn` with the server up; requests queue and run one at a time. */
  withServer<T>(fn: (h: SidecarHandle) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Stop now, whatever the idle timer says. */
  stop(): Promise<void>;
  running(): boolean;
}

export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/**
 * One keeper per sidecar kind: it serialises calls (a 1.5B model on a laptop cannot run two at once), starts
 * the server on the first call and stops it `idleMs` after the last.
 */
export function keeper(
  runtime: SidecarRuntime,
  kind: SidecarKind,
  args: { modelFile: string; threads?: number; idleMs?: number },
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  } = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as number),
  },
): Keeper {
  const idleMs = args.idleMs ?? DEFAULT_IDLE_MS;
  let handle: SidecarHandle | null = null;
  let starting: Promise<SidecarHandle> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let idle: unknown = null;

  const armIdle = () => {
    if (idle) timers.clearTimeout(idle);
    idle = timers.setTimeout(() => void stop(), idleMs);
  };
  const up = async (): Promise<SidecarHandle> => {
    if (handle) return handle;
    starting ??= runtime
      .start(kind, {
        modelFile: args.modelFile,
        ...(args.threads ? { threads: args.threads } : {}),
      })
      .then(
        (h) => {
          handle = h;
          starting = null;
          return h;
        },
        (e) => {
          starting = null;
          throw e;
        },
      );
    return starting;
  };
  const stop = async () => {
    if (idle) timers.clearTimeout(idle);
    idle = null;
    if (!handle && !starting) return;
    if (starting) await starting.catch(() => undefined);
    handle = null;
    await runtime.stop(kind);
  };

  return {
    withServer<T>(fn: (h: SidecarHandle) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const run = chain.then(async () => {
        if (signal?.aborted) throw new Error('cancelled');
        if (idle) timers.clearTimeout(idle);
        idle = null;
        try {
          return await fn(await up());
        } finally {
          armIdle();
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    stop,
    running: () => handle !== null,
  };
}

/** `fetch` with a JSON body, a timeout and the caller's abort signal, returning parsed JSON. */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: { signal?: AbortSignal | undefined; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<T> {
  const f = opts.fetchFn ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
