import { useSyncExternalStore } from 'react';

/**
 * A backup the system handed to the app (a `.gstbk` opened from the file manager). The Backup tab takes
 * it and opens its restore dialog on it, so the person still checks what it holds and chooses to
 * restore: opening a file never restores anything by itself.
 */
export interface PendingRestore {
  label: string;
  bytes: Uint8Array;
}

let pending: PendingRestore | null = null;
const listeners = new Set<() => void>();

export function offerRestore(p: PendingRestore): void {
  pending = p;
  listeners.forEach((l) => l());
}

export function takePendingRestore(): PendingRestore | null {
  const p = pending;
  pending = null;
  return p;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The waiting backup, if there is one (does not take it). */
export const usePendingRestore = (): PendingRestore | null =>
  useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
