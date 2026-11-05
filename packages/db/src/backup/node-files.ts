/**
 * Restoring into a database file on disk (the desktop app, and tests): build the restored database in
 * a separate staging file, check it, and only then swap it in with renames. The database that was in
 * use is never written to, so a crash, a kill or a power cut at any moment leaves either the old
 * database or the new one, never a mixture. Node only.
 */
import { existsSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { migrate } from '../migrate';
import { openNodeSqlite } from '../node-sqlite';

import {
  preflightBackup,
  type Preflight,
  type RestoreOptions,
  type RestoreResult,
  checkSqliteIntegrity,
  restoreAll,
} from './restore';

const SIDECARS = ['-wal', '-shm', '-journal'];

export interface FileRestoreOptions extends Omit<RestoreOptions, 'onBatch'> {
  /** The database file to replace (or create). */
  file: string;
  backup: Uint8Array;
  /** Called with each batch, as `restoreAll` does. */
  onBatch?: RestoreOptions['onBatch'];
  /** Called after the staging database is checked and closed, just before it is swapped in. */
  beforeSwap?: () => void | Promise<void>;
  /** Called between moving the old file aside and moving the new one in. */
  betweenRenames?: () => void | Promise<void>;
}

export interface FileRestoreResult extends RestoreResult {
  /** Where the database that was replaced now is, or null if there was none. */
  previous: string | null;
}

const rand = () => Math.random().toString(36).slice(2, 10);

/**
 * Windows keeps a database file locked for a moment after it is closed (an indexer or a scanner can
 * hold it too), so a rename or delete that fails as busy is tried again for a few seconds.
 */
async function retrying<T>(what: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await what();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') || attempt >= 60) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function moveWithSidecars(from: string, to: string): Promise<void> {
  await retrying(() => rename(from, to));
  for (const s of SIDECARS)
    if (existsSync(from + s)) await retrying(() => rename(from + s, to + s));
}

async function removeWithSidecars(file: string): Promise<void> {
  await retrying(() => rm(file, { force: true }));
  for (const s of SIDECARS) await retrying(() => rm(file + s, { force: true }));
}

/** Check a backup against this app before doing anything with a file. */
export async function preflightForFile(backup: Uint8Array): Promise<Preflight> {
  const probe = await openNodeSqlite();
  try {
    const { MIGRATIONS } = await import('../migrate');
    await migrate(probe);
    return await preflightBackup(backup, MIGRATIONS.sqlite.length);
  } finally {
    await probe.close();
  }
}

/**
 * Restore a backup over a database file, all or nothing. Returns where the old file went (it is kept
 * as `<file>.previous` until the next restore replaces it). Throws, leaving `file` as it was, on any
 * failure before the swap; the staging file is removed either way.
 */
export async function restoreIntoFile(opts: FileRestoreOptions): Promise<FileRestoreResult> {
  const { file } = opts;
  await recoverRestore(file);
  const staging = `${file}.restoring-${rand()}`;
  let result: RestoreResult;
  try {
    const stage = await openNodeSqlite(staging);
    try {
      await migrate(stage);
      result = await restoreAll(stage, opts.backup, {
        ...(opts.attachments ? { attachments: opts.attachments } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.yieldToUi ? { yieldToUi: opts.yieldToUi } : {}),
        ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
      });
    } finally {
      await stage.close();
    }
    // reopen what was written to disk, as it will be read, and check it before it replaces anything
    const check = await openNodeSqlite(staging);
    try {
      await checkSqliteIntegrity(check);
    } finally {
      await check.close();
    }
    await opts.beforeSwap?.();
  } catch (e) {
    await removeWithSidecars(staging);
    throw e;
  }

  const previous = `${file}.previous`;
  const hadOld = existsSync(file);
  if (hadOld) {
    await removeWithSidecars(previous);
    await moveWithSidecars(file, previous);
    await opts.betweenRenames?.();
  }
  await moveWithSidecars(staging, file);
  return { ...result, previous: hadOld ? previous : null };
}

/**
 * Tidy up after a restore that was cut short: remove staging files, and if the live file is missing
 * (killed between the two renames) put the previous one back. Safe to call at every start.
 */
export async function recoverRestore(
  file: string,
): Promise<{ restoredPrevious: boolean; removed: string[] }> {
  const dir = dirname(file);
  const base = basename(file);
  const removed: string[] = [];
  let restoredPrevious = false;
  if (!existsSync(file) && existsSync(`${file}.previous`)) {
    await moveWithSidecars(`${file}.previous`, file);
    restoredPrevious = true;
  }
  for (const name of await readdir(dir)) {
    if (name.startsWith(`${base}.restoring-`)) {
      await retrying(() => rm(join(dir, name), { force: true }));
      removed.push(name);
    }
  }
  return { restoredPrevious, removed };
}

/** Put the database that a restore replaced back, undoing the restore. */
export async function undoRestore(file: string): Promise<boolean> {
  const previous = `${file}.previous`;
  if (!existsSync(previous)) return false;
  const aside = `${file}.undone-${rand()}`;
  if (existsSync(file)) await moveWithSidecars(file, aside);
  await moveWithSidecars(previous, file);
  await removeWithSidecars(aside);
  return true;
}
