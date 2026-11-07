/**
 * The device's model manager: one per app, over the desktop's data folder (Tauri) or the browser's OPFS.
 * The manifest is verified against the key that ships with the app before anything is offered.
 */
import {
  ModelManager,
  classify,
  detectBrowserHardware,
  fetchRangeWithFetch,
  platformKey,
  verifyManifest,
  type Hardware,
  type ModelManifest,
  type ModelStorage,
  type SigningPublicKey,
} from '@gst/ai';
import signingKey from '@gst/ai/data/model-signing-key.json';
import { useSyncExternalStore } from 'react';

import {
  aiAppend,
  aiFileSize,
  aiFinish,
  aiFreeBytes,
  aiHardware,
  aiReadText,
  aiRemove,
  aiSha256,
  aiWriteText,
  isDesktop,
} from '../desktop/bridge';

export const KEY: SigningPublicKey = signingKey as SigningPublicKey;
/** The manifest the app ships with (signed at release time by `packages/ai/scripts/make-manifest.ts`). */
export const BUNDLED_MANIFEST_URL = '/ai/models.json';

const STATE_FILE = 'models-state.json';
const CHUNK = 1024 * 1024;

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Files under `<data>/models` on the desktop, through the Rust commands. */
class TauriModelStorage implements ModelStorage {
  size = (file: string) => aiFileSize(file);
  async append(file: string, chunk: Uint8Array): Promise<void> {
    for (let i = 0; i < chunk.length; i += CHUNK)
      await aiAppend(file, toBase64(chunk.subarray(i, i + CHUNK)));
  }
  remove = (file: string) => aiRemove(file).then(() => undefined);
  finish = (partial: string, file: string) => aiFinish(partial, file).then(() => undefined);
  sha256 = (file: string) => aiSha256(file);
  readState = () => aiReadText(STATE_FILE);
  writeState = (json: string) => aiWriteText(STATE_FILE, json).then(() => undefined);
  freeBytes = () => aiFreeBytes();
}

/** Files in the browser's private file system (`gst-models`), for OCR language data in the PWA. */
class OpfsModelStorage implements ModelStorage {
  private async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('gst-models', { create: true });
  }
  async size(file: string): Promise<number | null> {
    try {
      const h = await (await this.dir()).getFileHandle(file);
      return (await h.getFile()).size;
    } catch {
      return null;
    }
  }
  async append(file: string, chunk: Uint8Array): Promise<void> {
    const h = await (await this.dir()).getFileHandle(file, { create: true });
    const size = (await h.getFile()).size;
    const w = await h.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(chunk as BufferSource);
    await w.close();
  }
  async remove(file: string): Promise<void> {
    try {
      await (await this.dir()).removeEntry(file);
    } catch {
      /* already gone */
    }
  }
  async finish(partial: string, file: string): Promise<void> {
    const d = await this.dir();
    const src = await (await d.getFileHandle(partial)).getFile();
    const dst = await d.getFileHandle(file, { create: true });
    const w = await dst.createWritable();
    await w.write(await src.arrayBuffer());
    await w.close();
    await d.removeEntry(partial);
  }
  async sha256(file: string): Promise<string> {
    const f = await (await (await this.dir()).getFileHandle(file)).getFile();
    const digest = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async readState(): Promise<string | null> {
    try {
      return await (
        await (await this.dir()).getFileHandle(STATE_FILE)
      )
        .getFile()
        .then((f) => f.text());
    } catch {
      return null;
    }
  }
  async writeState(json: string): Promise<void> {
    const h = await (await this.dir()).getFileHandle(STATE_FILE, { create: true });
    const w = await h.createWritable();
    await w.write(json);
    await w.close();
  }
  async freeBytes(): Promise<number | null> {
    try {
      const e = await navigator.storage.estimate();
      return e.quota && e.usage !== undefined ? e.quota - e.usage : null;
    } catch {
      return null;
    }
  }
  /** The bytes of a ready file, for engines that take a URL or a blob. */
  async blob(file: string): Promise<Blob> {
    return (await (await this.dir()).getFileHandle(file)).getFile();
  }
}

let manager: ModelManager | null = null;
let storage: TauriModelStorage | OpfsModelStorage | null = null;

export function modelStorage(): TauriModelStorage | OpfsModelStorage {
  storage ??= isDesktop() ? new TauriModelStorage() : new OpfsModelStorage();
  return storage;
}

export function modelManager(): ModelManager {
  manager ??= new ModelManager(modelStorage(), fetchRangeWithFetch);
  return manager;
}

export type ManifestLoad =
  | { ok: true; manifest: ModelManifest; from: string }
  | { ok: false; reason: 'network' | 'shape' | 'key' | 'signature'; from: string };

/** Fetch and verify a manifest. Only https, or the app's own file, or localhost for testing. */
export async function loadManifest(url: string): Promise<ManifestLoad> {
  const from = url || BUNDLED_MANIFEST_URL;
  try {
    const u = new URL(from, window.location.origin);
    const own = u.origin === window.location.origin;
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (!own && u.protocol !== 'https:' && !local) return { ok: false, reason: 'network', from };
    const res = await fetch(u.toString(), { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'network', from };
    const check = await verifyManifest(await res.json(), KEY);
    if (!check.ok) return { ok: false, reason: check.reason, from };
    await modelManager().setManifest(check.manifest);
    return { ok: true, manifest: check.manifest, from };
  } catch {
    return { ok: false, reason: 'network', from };
  }
}

let hardware: Hardware | null = null;

/** The desktop asks Rust; the browser reads what the browser will say. */
export async function detectHardware(): Promise<Hardware> {
  if (hardware) return hardware;
  if (isDesktop()) {
    try {
      const h = await aiHardware();
      hardware = {
        ramGb: h.ramGb,
        cores: h.cores,
        gpu: h.gpu as Hardware['gpu'],
        os: h.os as Hardware['os'],
        arch: h.arch as Hardware['arch'],
      };
      return hardware;
    } catch {
      /* an app built without the feature: fall back to what the webview says */
    }
  }
  hardware = detectBrowserHardware(
    navigator as unknown as Parameters<typeof detectBrowserHardware>[0],
  );
  return hardware;
}

export const deviceClassOf = (hw: Hardware) => classify(hw);
export const platformOf = (hw: Hardware) => platformKey(hw);

/** Re-render when any model's state changes. */
export function useModelStates() {
  const m = modelManager();
  return useSyncExternalStore(
    (l) => m.subscribe(l),
    () =>
      m
        .states()
        .map((s) => `${s.id}:${s.status}:${s.bytes}:${s.licenceAcceptedAt ?? ''}:${s.error ?? ''}`)
        .join('|'),
  );
}

/** The file name (desktop: full path under the models folder) of a ready model, or null. */
export async function readyModelFile(id: string | null): Promise<string | null> {
  if (!id) return null;
  const m = modelManager();
  const e = m.entry(id);
  return e && m.get(id)?.status === 'ready' ? e.file : null;
}
