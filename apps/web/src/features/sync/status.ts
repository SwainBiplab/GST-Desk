/**
 * What the sync pill shows (prompt 41, UX-10). The sync client (PowerSync on the desktop and the phone)
 * reports into this store; a book that is local only shows "Local". Pure functions decide the label, so
 * they are tested without a screen.
 */
import { useSyncExternalStore } from 'react';

export interface SyncStatus {
  /** A sync client is running for the open business. */
  attached: boolean;
  connected: boolean;
  uploading: boolean;
  downloading: boolean;
  lastSyncedAt: number | null;
  /** Local transactions waiting to upload. */
  pending: number;
  /** Recent failures (network, server), newest first. */
  errors: { at: number; message: string }[];
  /** The first download of a book (or a large catch-up): how far it has come. */
  progress: { done: number; total: number; fraction: number } | null;
}

export const IDLE: SyncStatus = {
  attached: false,
  connected: false,
  uploading: false,
  downloading: false,
  lastSyncedAt: null,
  pending: 0,
  errors: [],
  progress: null,
};

let status: SyncStatus = IDLE;
let syncNow: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export const getSyncStatus = (): SyncStatus => status;
export function setSyncStatus(next: Partial<SyncStatus>): void {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
}
export function resetSyncStatus(): void {
  status = IDLE;
  syncNow = null;
  listeners.forEach((l) => l());
}

/** The sync client registers how to sync at once (the sheet's "Sync now"). */
export function registerSyncNow(fn: (() => Promise<void>) | null): void {
  syncNow = fn;
  listeners.forEach((l) => l());
}
export const canSyncNow = (): boolean => syncNow !== null;
export async function runSyncNow(): Promise<void> {
  await syncNow?.();
}

export const useSyncStatus = (): SyncStatus =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );

export type PillKind =
  'local' | 'synced' | 'syncing' | 'pending' | 'conflict' | 'offline' | 'error';

export interface PillState {
  kind: PillKind;
  count: number;
  tone: 'neutral' | 'success' | 'info' | 'warning' | 'danger';
}

/**
 * Most urgent first: a conflict needs a person; an error says sync is stuck; offline with changes waiting
 * says they are safe here but not shared yet; then syncing, then all synced.
 */
export function pillState(mode: 'local' | 'synced', s: SyncStatus, conflicts: number): PillState {
  if (mode === 'local') return { kind: 'local', count: 0, tone: 'neutral' };
  if (conflicts > 0) return { kind: 'conflict', count: conflicts, tone: 'danger' };
  if (!s.attached || !s.connected) return { kind: 'offline', count: s.pending, tone: 'warning' };
  if (s.errors.length && s.pending > 0) return { kind: 'error', count: s.pending, tone: 'danger' };
  if (s.pending > 0) return { kind: 'pending', count: s.pending, tone: 'info' };
  if (s.uploading || s.downloading || s.lastSyncedAt === null)
    return { kind: 'syncing', count: 0, tone: 'info' };
  return { kind: 'synced', count: 0, tone: 'success' };
}
