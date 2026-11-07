/**
 * The model manager: downloads from a verified manifest, resumes after a pause or a crash, checks the hash
 * before a file is called ready, and keeps the licence acceptance per model. It talks to the disk and the
 * network through two small interfaces, so it runs unchanged in tests, in Node and on the desktop.
 */
import type { ModelEntry, ModelManifest } from './manifest';

export interface ModelStorage {
  /** Size of a file under the models folder, or null when it is not there. */
  size(file: string): Promise<number | null>;
  append(file: string, chunk: Uint8Array): Promise<void>;
  remove(file: string): Promise<void>;
  /** Rename a finished partial file to its final name. */
  finish(partial: string, file: string): Promise<void>;
  sha256(file: string): Promise<string>;
  readState(): Promise<string | null>;
  writeState(json: string): Promise<void>;
  freeBytes?(): Promise<number | null>;
}

export interface FetchedRange {
  /** 200 (whole file), 206 (the range asked for), or anything else for a failure. */
  status: number;
  /** Total size of the whole file when the server says. */
  totalBytes: number | null;
  body: AsyncIterable<Uint8Array>;
}

/** `GET url` with `Range: bytes=<from>-` when `from` is above zero. */
export type RangeFetcher = (
  url: string,
  from: number,
  signal: AbortSignal,
) => Promise<FetchedRange>;

export type ModelStatus = 'none' | 'downloading' | 'paused' | 'verifying' | 'ready' | 'error';

export interface ModelState {
  id: string;
  status: ModelStatus;
  bytes: number;
  totalBytes: number;
  licenceAcceptedAt: number | null;
  error: string | null;
  readyAt: number | null;
}

interface Persisted {
  models: Record<string, Pick<ModelState, 'licenceAcceptedAt' | 'readyAt' | 'status'>>;
}

export class ModelError extends Error {
  constructor(
    readonly code: 'licence' | 'unknown_model' | 'busy' | 'hash' | 'network' | 'space',
    message: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

const PART = (file: string) => `${file}.part`;

export class ModelManager {
  private manifest: ModelManifest | null = null;
  private readonly state = new Map<string, ModelState>();
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly storage: ModelStorage,
    private readonly fetchRange: RangeFetcher,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The verified manifest to work from. Models already on disk keep their state. */
  async setManifest(m: ModelManifest): Promise<void> {
    this.manifest = m;
    await this.load();
    for (const e of m.models) {
      const s = this.state.get(e.id) ?? this.blank(e);
      s.totalBytes = e.sizeBytes;
      this.state.set(e.id, s);
    }
    await this.refreshFromDisk();
    this.emit();
  }

  entries(): ModelEntry[] {
    return this.manifest?.models ?? [];
  }

  entry(id: string): ModelEntry | undefined {
    return this.manifest?.models.find((e) => e.id === id);
  }

  states(): ModelState[] {
    return [...this.state.values()];
  }

  get(id: string): ModelState | undefined {
    return this.state.get(id);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** The person has read the licence of this model. Required before a download. */
  async acceptLicence(id: string): Promise<void> {
    const s = this.must(id);
    s.licenceAcceptedAt = this.clock();
    await this.persist();
    this.emit();
  }

  /**
   * Download, or carry on with, a model. Resolves when it is ready or paused; rejects on a wrong hash or
   * a network failure (the partial file is kept for a retry, except after a wrong hash).
   */
  async download(id: string): Promise<ModelState> {
    const e = this.entry(id);
    const s = this.must(id);
    if (!e) throw new ModelError('unknown_model', `no model "${id}" in the manifest`);
    if (!s.licenceAcceptedAt) throw new ModelError('licence', 'the licence has not been accepted');
    if (s.status === 'ready') return s;
    if (this.running.has(id)) throw new ModelError('busy', 'already downloading');

    const part = PART(e.file);
    const have = (await this.storage.size(part)) ?? 0;
    if (have === 0) {
      const free = (await this.storage.freeBytes?.()) ?? null;
      if (free !== null && free < e.sizeBytes)
        throw new ModelError('space', `needs ${e.sizeBytes} bytes, ${free} free`);
    }
    const ctl = new AbortController();
    this.running.set(id, ctl);
    s.status = 'downloading';
    s.bytes = have;
    s.error = null;
    this.emit();
    try {
      let got = have;
      if (got < e.sizeBytes) {
        const res = await this.fetchRange(e.url, got, ctl.signal);
        if (res.status === 200 && got > 0) {
          // the server ignored the range: start again
          await this.storage.remove(part);
          got = 0;
          s.bytes = 0;
        } else if (res.status !== 200 && res.status !== 206) {
          throw new ModelError('network', `server answered ${res.status}`);
        }
        if (res.totalBytes !== null && res.totalBytes !== e.sizeBytes && res.status === 200)
          throw new ModelError(
            'hash',
            `the file is ${res.totalBytes} bytes, expected ${e.sizeBytes}`,
          );
        for await (const chunk of res.body) {
          if (ctl.signal.aborted) break;
          await this.storage.append(part, chunk);
          got += chunk.length;
          s.bytes = got;
          if (got > e.sizeBytes) throw new ModelError('hash', 'the file is larger than expected');
          this.emit();
        }
      }
      if (ctl.signal.aborted) {
        s.status = 'paused';
        await this.persist();
        this.emit();
        return s;
      }
      s.status = 'verifying';
      this.emit();
      const hash = await this.storage.sha256(part);
      if (hash !== e.sha256) {
        await this.storage.remove(part);
        s.bytes = 0;
        throw new ModelError('hash', 'the downloaded file does not match its checksum');
      }
      await this.storage.finish(part, e.file);
      s.status = 'ready';
      s.readyAt = this.clock();
      await this.persist();
      this.emit();
      return s;
    } catch (err) {
      if (ctl.signal.aborted) {
        s.status = 'paused';
      } else {
        s.status = 'error';
        s.error = err instanceof Error ? err.message : String(err);
      }
      await this.persist();
      this.emit();
      throw err;
    } finally {
      this.running.delete(id);
    }
  }

  /** Stop the transfer and keep what has arrived. `download` carries on from there. */
  pause(id: string): void {
    this.running.get(id)?.abort();
  }

  async delete(id: string): Promise<void> {
    const e = this.entry(id);
    const s = this.must(id);
    this.pause(id);
    if (e) {
      await this.storage.remove(PART(e.file));
      await this.storage.remove(e.file);
    }
    s.status = 'none';
    s.bytes = 0;
    s.readyAt = null;
    s.error = null;
    await this.persist();
    this.emit();
  }

  /** Bytes on disk for every model, ready or partial. */
  async diskUsage(): Promise<number> {
    let total = 0;
    for (const e of this.entries()) {
      total += (await this.storage.size(e.file)) ?? 0;
      total += (await this.storage.size(PART(e.file))) ?? 0;
    }
    return total;
  }

  /** Ready models of a kind, newest first. */
  ready(kind?: ModelEntry['kind']): ModelEntry[] {
    return this.entries().filter(
      (e) => (!kind || e.kind === kind) && this.state.get(e.id)?.status === 'ready',
    );
  }

  private blank(e: ModelEntry): ModelState {
    return {
      id: e.id,
      status: 'none',
      bytes: 0,
      totalBytes: e.sizeBytes,
      licenceAcceptedAt: null,
      error: null,
      readyAt: null,
    };
  }

  private must(id: string): ModelState {
    const s = this.state.get(id);
    if (!s) throw new ModelError('unknown_model', `no model "${id}" in the manifest`);
    return s;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const raw = await this.storage.readState();
      if (!raw) return;
      try {
        const p = JSON.parse(raw) as Persisted;
        for (const [id, v] of Object.entries(p.models ?? {})) {
          const e = this.entry(id);
          this.state.set(id, {
            ...(e
              ? this.blank(e)
              : {
                  id,
                  status: 'none',
                  bytes: 0,
                  totalBytes: 0,
                  licenceAcceptedAt: null,
                  error: null,
                  readyAt: null,
                }),
            licenceAcceptedAt: v.licenceAcceptedAt ?? null,
            readyAt: v.readyAt ?? null,
          });
        }
      } catch {
        /* a broken state file is the same as none: the disk is the truth */
      }
    })();
    return this.loaded;
  }

  /** The disk decides: a whole file with the right size is ready, a partial one is paused. */
  private async refreshFromDisk(): Promise<void> {
    for (const e of this.entries()) {
      const s = this.state.get(e.id)!;
      if (this.running.has(e.id)) continue;
      const whole = await this.storage.size(e.file);
      if (whole === e.sizeBytes) {
        s.status = 'ready';
        s.bytes = whole;
        continue;
      }
      const part = await this.storage.size(PART(e.file));
      if (part !== null && part > 0) {
        s.status = 'paused';
        s.bytes = part;
      } else {
        s.status = s.status === 'error' ? 'error' : 'none';
        s.bytes = 0;
      }
    }
  }

  private async persist(): Promise<void> {
    const models: Persisted['models'] = {};
    for (const s of this.state.values())
      models[s.id] = {
        licenceAcceptedAt: s.licenceAcceptedAt,
        readyAt: s.readyAt,
        status: s.status,
      };
    await this.storage.writeState(JSON.stringify({ models }));
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

/** In-memory storage for tests and for a browser without a file system. */
export class MemoryModelStorage implements ModelStorage {
  readonly files = new Map<string, Uint8Array[]>();
  state: string | null = null;
  free: number | null = null;

  async size(file: string): Promise<number | null> {
    const parts = this.files.get(file);
    return parts ? parts.reduce((a, p) => a + p.length, 0) : null;
  }
  async append(file: string, chunk: Uint8Array): Promise<void> {
    const parts = this.files.get(file) ?? [];
    parts.push(chunk);
    this.files.set(file, parts);
  }
  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }
  async finish(partial: string, file: string): Promise<void> {
    const parts = this.files.get(partial);
    if (!parts) throw new Error(`no partial file ${partial}`);
    this.files.delete(partial);
    this.files.set(file, parts);
  }
  async sha256(file: string): Promise<string> {
    const bytes = this.bytes(file);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  bytes(file: string): Uint8Array<ArrayBuffer> {
    const parts = this.files.get(file) ?? [];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  async readState(): Promise<string | null> {
    return this.state;
  }
  async writeState(json: string): Promise<void> {
    this.state = json;
  }
  async freeBytes(): Promise<number | null> {
    return this.free;
  }
}

/** A `RangeFetcher` over the global `fetch`, for Node and the browser. */
export const fetchRangeWithFetch: RangeFetcher = async (url, from, signal) => {
  const res = await fetch(url, {
    signal,
    headers: from > 0 ? { Range: `bytes=${from}-` } : {},
  });
  const len = res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
  const total = len
    ? Number(len)
    : res.headers.get('content-length') && from === 0
      ? Number(res.headers.get('content-length'))
      : null;
  const body = res.body;
  async function* iterate(): AsyncIterable<Uint8Array> {
    if (!body) return;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  return { status: res.status, totalBytes: total, body: iterate() };
};
