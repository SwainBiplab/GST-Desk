/**
 * Sidecars on the desktop: llama.cpp, whisper.cpp and the OCR server are started by Rust from the
 * runtime bundle the model manager downloaded, bound to localhost, and stopped when idle.
 */
import { keeper, type Keeper, type SidecarKind, type SidecarRuntime } from '@gst/ai';

import { sidecarStart, sidecarStop } from '../desktop/bridge';

export const tauriRuntime: SidecarRuntime = {
  start: (kind, args) => sidecarStart(kind, args.modelFile, args.threads),
  stop: (kind) => sidecarStop(kind).then(() => undefined),
};

const keepers = new Map<string, Keeper>();

/** One keeper per kind and model file; a change of model stops the old server. */
export function keeperFor(kind: SidecarKind, modelFile: string, threads?: number): Keeper {
  const key = `${kind}:${modelFile}`;
  const have = keepers.get(key);
  if (have) return have;
  for (const [k, old] of keepers) {
    if (k.startsWith(`${kind}:`)) {
      void old.stop();
      keepers.delete(k);
    }
  }
  const k = keeper(tauriRuntime, kind, { modelFile, ...(threads ? { threads } : {}) });
  keepers.set(key, k);
  return k;
}

export async function stopAllSidecars(): Promise<void> {
  await Promise.all([...keepers.values()].map((k) => k.stop()));
  keepers.clear();
}
