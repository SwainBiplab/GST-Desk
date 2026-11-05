/**
 * Where backup files are kept in the browser: a folder in the app's own storage (always there), and,
 * where the browser allows it, a folder on the person's disk that they choose, which gets a copy of
 * every backup. The first is convenient but is wiped if browser data is cleared; the second is what
 * actually protects against that.
 */
import { backupKindOf, backupTimeOf, type BackupKind } from '@gst/db';

const DIR = 'gst-backups';

export interface BackupEntry {
  name: string;
  size: number;
  /** When it was made (from its name). */
  at: number;
  kind: BackupKind;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

/** Is there somewhere in this browser to keep backups? */
export const canKeepBackups = async (): Promise<boolean> => (await dir()) !== null;

async function writeFile(
  into: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await into.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
}

/** Keep a backup in the app's storage, and in the chosen folder when there is one and it is allowed. */
export async function saveBackup(
  name: string,
  bytes: Uint8Array,
): Promise<{ folderCopy: boolean; folderError: string | null }> {
  const d = await dir();
  if (!d)
    throw new Error(
      'This browser cannot keep files for the app, so a backup can only be downloaded.',
    );
  await writeFile(d, name, bytes);
  const f = await folderHandle();
  if (!f) return { folderCopy: false, folderError: null };
  try {
    if ((await folderPermission(f, false)) !== 'granted')
      return {
        folderCopy: false,
        folderError: 'Allow access to the backup folder to copy backups there.',
      };
    await writeFile(f, name, bytes);
    return { folderCopy: true, folderError: null };
  } catch (e) {
    return { folderCopy: false, folderError: e instanceof Error ? e.message : String(e) };
  }
}

export async function listBackups(): Promise<BackupEntry[]> {
  const d = await dir();
  if (!d) return [];
  const out: BackupEntry[] = [];
  for await (const [name, handle] of (
    d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    const kind = backupKindOf(name);
    const at = backupTimeOf(name);
    if (!kind || !at || handle.kind !== 'file') continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    out.push({ name, size: file.size, at: at.getTime(), kind });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function readBackup(name: string): Promise<Uint8Array | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const file = await (await d.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function deleteBackup(name: string): Promise<void> {
  const d = await dir();
  try {
    await d?.removeEntry(name);
  } catch {
    // already gone
  }
}

/* ------------------------------------------------------------------ a folder on the person's disk */

const IDB = 'gst-backup-folder';
const STORE = 'handles';

/** Choosing a folder needs the File System Access API (Chrome, Edge and other Chromium browsers). */
export const canChooseFolder = (): boolean =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as T | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: unknown | null): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value === null) tx.objectStore(STORE).delete(key);
    else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

export const folderHandle = (): Promise<FileSystemDirectoryHandle | null> =>
  idbGet<FileSystemDirectoryHandle>('folder');

export async function folderPermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
): Promise<PermissionState> {
  const h = handle as PermissionHandle;
  const state = await h.queryPermission({ mode: 'readwrite' });
  if (state === 'granted' || !request) return state;
  return h.requestPermission({ mode: 'readwrite' });
}

/** Ask the person for a folder and remember it. Returns its name, or null if they cancelled. */
export async function chooseFolder(): Promise<string | null> {
  try {
    const handle = await (
      window as unknown as {
        showDirectoryPicker(o: {
          mode: 'readwrite';
          id: string;
        }): Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode: 'readwrite', id: 'gst-backups' });
    await idbSet('folder', handle);
    return handle.name;
  } catch {
    return null;
  }
}

export async function clearFolder(): Promise<void> {
  await idbSet('folder', null);
}

export async function folderName(): Promise<string | null> {
  return (await folderHandle())?.name ?? null;
}
