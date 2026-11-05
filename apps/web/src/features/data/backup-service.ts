/**
 * Backups in the browser: make one (checked, kept, copied to the chosen folder), decide when one is
 * due, keep only as many as the policy says, and restore one safely. The database engine is in
 * `@gst/db`; this is the glue to the browser's storage and the person's disk.
 */
import {
  SettingsRepo,
  MIGRATIONS,
  TABLES,
  announce,
  backupFileName,
  buildSchema,
  createBackup,
  exportBusinessJson,
  exportCsvBundle,
  importBusinessData,
  migrate,
  parseExportJson,
  preflightBackup,
  readManifest,
  restoreAll,
  sha256Hex,
  verifyBackup,
  type AttachmentSink,
  type AttachmentSource,
  type BackupKind,
  type BackupManifest,
  type BackupProgress,
  type Ctx,
  type Database,
  type ImportResult,
  type Preflight,
} from '@gst/db';
import {
  DEFAULT_SCHEDULE,
  downloadReminderDue,
  isBackupDue,
  retentionPlan,
  type BackupSchedule,
} from '@gst/domain';
import { useSyncExternalStore } from 'react';

import { deleteBackup, listBackups, readBackup, saveBackup } from './backup-store';
import { uploadBackup, type CloudCredentials } from './cloud';

import { getBlob, putBlob } from '@/app/blobs';
import { removeLocationFiles, stagingLocation, switchTo } from '@/app/db-location';
import { isTauri, openTauriBackend, openWorkerBackend } from '@/app/sqlite/backends';
import { createDrizzle } from '@/app/sqlite/proxy';
import { downloadBytes, fileSafe } from '@/features/reports/download';
import { track } from '@/features/telemetry/telemetry';

/* ------------------------------------------------------------------ this device's backup facts */

/**
 * What this device knows about its backups. Kept in `localStorage`, not in the database, because a
 * restore replaces the database and this must say what happened to it.
 */
export interface BackupStatus {
  lastAt: number | null;
  lastName: string | null;
  lastKind: BackupKind | null;
  ok: boolean;
  error: string | null;
  failedAt: number | null;
  bytes: number;
  rows: number;
  /** The last time a backup was downloaded from the browser. */
  lastDownloadAt: number | null;
  /** When this device first held data, so a new install is not nagged on day one. */
  sinceAt: number;
  snoozeUntil: number | null;
  /** Why the copy in the chosen folder was not made, if it was not. */
  folderError: string | null;
  /** The last upload to the person's cloud drive, and why one failed (desktop only). */
  cloudAt: number | null;
  cloudError: string | null;
}

const STATUS_KEY = 'gst.backup.status';
const SCHEDULE_KEY = 'gst.backup.schedule';
const EVENT = 'gst-backup-status';

const fresh = (): BackupStatus => ({
  lastAt: null,
  lastName: null,
  lastKind: null,
  ok: true,
  error: null,
  failedAt: null,
  bytes: 0,
  rows: 0,
  lastDownloadAt: null,
  sinceAt: Date.now(),
  snoozeUntil: null,
  folderError: null,
  cloudAt: null,
  cloudError: null,
});

let cached: BackupStatus | null = null;

export function readStatus(): BackupStatus {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    cached = raw ? { ...fresh(), ...(JSON.parse(raw) as Partial<BackupStatus>) } : fresh();
    if (!raw) localStorage.setItem(STATUS_KEY, JSON.stringify(cached));
  } catch {
    cached = fresh();
  }
  return cached;
}

export function writeStatus(patch: Partial<BackupStatus>): BackupStatus {
  cached = { ...readStatus(), ...patch };
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(cached));
  } catch {
    // the page still shows it for this session
  }
  window.dispatchEvent(new Event(EVENT));
  return cached;
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
};

export const useBackupStatus = (): BackupStatus =>
  useSyncExternalStore(subscribe, readStatus, readStatus);

export function readSchedule(): BackupSchedule {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    return raw
      ? { ...DEFAULT_SCHEDULE, ...(JSON.parse(raw) as Partial<BackupSchedule>) }
      : DEFAULT_SCHEDULE;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

export function writeSchedule(s: BackupSchedule): void {
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s));
  } catch {
    // the choice lasts for this session only
  }
  window.dispatchEvent(new Event(EVENT));
}

/* ------------------------------------------------------------------ files that rows point at */

export const attachmentSource: AttachmentSource = {
  async read(storagePath) {
    const blob = await getBlob(storagePath);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  },
};

export const attachmentSink: AttachmentSink = {
  async write(sha256, bytes) {
    const stored = await putBlob(new Blob([bytes as unknown as BlobPart]));
    if (stored.sha256 !== sha256) throw new Error('A restored file did not match its checksum.');
  },
};

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ making a backup */

export interface BackupResult {
  name: string;
  bytes: Uint8Array;
  manifest: BackupManifest;
}

let running: Promise<BackupResult> | null = null;

/**
 * Make a backup, check it, keep it, and read it back from where it was kept: a backup that cannot be
 * read back is not a backup. Two at once share one run. A failure is recorded (the bell shows it) and
 * thrown.
 */
export function runBackup(
  database: Database,
  kind: BackupKind,
  onProgress?: (p: BackupProgress) => void,
): Promise<BackupResult> {
  if (running) return running;
  running = (async () => {
    try {
      const at = new Date();
      const { bytes, manifest } = await createBackup(database, {
        attachments: attachmentSource,
        yieldToUi,
        now: () => at,
        app: 'gst-desk-web',
        ...(onProgress ? { onProgress } : {}),
      });
      const check = await verifyBackup(bytes, yieldToUi);
      if (check.problems.length > 0)
        throw new Error(`The backup did not check out: ${check.problems[0]}`);
      const name = backupFileName(at, kind);
      const saved = await saveBackup(name, bytes);
      const back = await readBackup(name);
      if (
        !back ||
        back.length !== bytes.length ||
        (await sha256Hex(back)) !== (await sha256Hex(bytes))
      )
        throw new Error('The backup was written but could not be read back.');
      await applyRetention();
      if (kind !== 'pre-migration')
        writeStatus({
          lastAt: at.getTime(),
          lastName: name,
          lastKind: kind,
          ok: true,
          error: null,
          failedAt: null,
          bytes: bytes.length,
          rows: manifest.totals.rows,
          folderError: saved.folderError,
        });
      if (kind === 'manual') track('backup_made');
      return { name, bytes, manifest };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (kind !== 'pre-migration')
        writeStatus({ ok: false, error: message, failedAt: Date.now() });
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** How many backups made by hand, and how many taken before an update, are kept. */
export const KEEP_MANUAL = 10;
export const KEEP_PRE_MIGRATION = 3;

/**
 * Tidy the kept backups. Automatic ones follow the rule (the newest of each of the last 30 days and
 * 12 months). Ones the person made are their own choice and are never thinned by day: the newest ten
 * stay. The last three taken before an update stay. Returns what was removed.
 */
export async function applyRetention(now = Date.now()): Promise<string[]> {
  const all = await listBackups();
  const auto = all.filter((b) => b.kind === 'auto');
  const plan = retentionPlan(
    auto.map((b) => ({ name: b.name, at: b.at })),
    now,
  );
  const removed = [
    ...plan.remove,
    ...all
      .filter((b) => b.kind === 'manual')
      .slice(KEEP_MANUAL)
      .map((b) => b.name),
    ...all
      .filter((b) => b.kind === 'pre-migration')
      .slice(KEEP_PRE_MIGRATION)
      .map((b) => b.name),
  ];
  for (const name of removed) await deleteBackup(name);
  return removed;
}

/** Back up when the schedule says one is due. Returns whether one was taken. */
export async function autoBackupIfDue(
  database: Database,
  ctx: Ctx,
  now = Date.now(),
): Promise<boolean> {
  const s = readStatus();
  if (!isBackupDue(s.lastAt, now, readSchedule())) return false;
  // a failed attempt is retried at the next opening, not in a loop within this one
  if (s.failedAt && now - s.failedAt < 60 * 60_000) return false;
  try {
    const r = await runBackup(database, 'auto');
    await cloudUploadIfEnabled(database, ctx, r.name, r.bytes);
    return true;
  } catch {
    return false;
  }
}

/** Taken before the database is changed by an update. Failing stops the update: data comes first. */
export async function preMigrationBackup(database: Database): Promise<void> {
  await runBackup(database, 'pre-migration');
}

/** Make a backup and hand it to the browser as a download. */
export async function downloadNewBackup(
  database: Database,
  onProgress?: (p: BackupProgress) => void,
): Promise<BackupResult> {
  const r = await runBackup(database, 'manual', onProgress);
  downloadBytes(r.name, r.bytes as unknown as BlobPart, 'application/zip');
  writeStatus({ lastDownloadAt: Date.now() });
  return r;
}

export async function downloadStored(name: string): Promise<boolean> {
  const bytes = await readBackup(name);
  if (!bytes) return false;
  downloadBytes(name, bytes as unknown as BlobPart, 'application/zip');
  writeStatus({ lastDownloadAt: Date.now() });
  return true;
}

/** Whether to ask this person to download a backup (browser only: the desktop app backs up to disk). */
export const reminderDue = (now = Date.now()): boolean => {
  const s = readStatus();
  if (s.snoozeUntil && now < s.snoozeUntil) return false;
  return downloadReminderDue(s.lastDownloadAt, s.sinceAt, now);
};

export const snoozeReminder = (days = 1, now = Date.now()): void => {
  writeStatus({ snoozeUntil: now + days * 86_400_000 });
};

/* ------------------------------------------------------------------ restoring */

export async function preflight(bytes: Uint8Array): Promise<Preflight> {
  return preflightBackup(bytes, MIGRATIONS.sqlite.length);
}

/**
 * Restore a backup in the browser, all or nothing. The backup is unpacked into a second database
 * beside the one in use, which is checked; only then is the app pointed at it, with one write. The
 * database in use is never touched, so any failure before that point changes nothing. The caller
 * reloads the page.
 */
export async function restoreInBrowser(
  bytes: Uint8Array,
  onProgress?: (p: BackupProgress) => void,
): Promise<{ rows: number }> {
  const loc = stagingLocation();
  const { backend, info } = isTauri()
    ? await openTauriBackend(await (await import('@/app/db-impl')).desktopDbPath(loc), 'staging')
    : await openWorkerBackend(loc.file, loc.dir);
  const staging: Database = {
    dialect: 'sqlite',
    db: createDrizzle(backend),
    schema: buildSchema('sqlite'),
    close: () => backend.close(),
  };
  try {
    if (!info.persistent)
      throw new Error(
        'This browser cannot keep a restored database. Use a browser that allows site storage.',
      );
    await migrate(staging);
    const result = await restoreAll(staging, bytes, {
      attachments: attachmentSink,
      yieldToUi,
      ...(onProgress ? { onProgress } : {}),
    });
    await staging.close();
    switchTo(loc);
    track('backup_restored');
    return { rows: result.rows };
  } catch (e) {
    await staging.close().catch(() => undefined);
    await removeLocationFiles(loc);
    throw e;
  }
}

export const manifestOf = (bytes: Uint8Array): BackupManifest => readManifest(bytes);

/* ------------------------------------------------------------------ export and import */

const ALL_TABLES = TABLES.map((t) => t.name);

export async function exportJson(
  database: Database,
  ctx: Ctx,
  businessName: string,
): Promise<void> {
  const text = await exportBusinessJson(database, ctx.businessId);
  const day = new Date().toISOString().slice(0, 10);
  downloadBytes(`${fileSafe(businessName)}_${day}.gst.json`, text, 'application/json');
}

export async function exportCsv(database: Database, ctx: Ctx, businessName: string): Promise<void> {
  const zip = await exportCsvBundle(database, ctx.businessId, { attachments: attachmentSource });
  const day = new Date().toISOString().slice(0, 10);
  downloadBytes(
    `${fileSafe(businessName)}_${day}_csv.zip`,
    zip as unknown as BlobPart,
    'application/zip',
  );
}

/** Read an export file and say what importing it would do, writing nothing. */
export async function previewImport(
  database: Database,
  ctx: Ctx,
  text: string,
): Promise<ImportResult> {
  return importBusinessData(database, parseExportJson(text), {
    orgId: ctx.orgId,
    actor: ctx.actor,
    dryRun: true,
  });
}

/** Import an export file as a new business. */
export async function importJson(
  database: Database,
  ctx: Ctx,
  text: string,
): Promise<ImportResult> {
  const r = await importBusinessData(database, parseExportJson(text), {
    orgId: ctx.orgId,
    actor: ctx.actor,
  });
  announce(database, ALL_TABLES);
  return r;
}

/* ------------------------------------------------------------------ the cloud drive (desktop) */

export interface CloudSettings extends CloudCredentials {
  enabled: boolean;
}

/** The credentials are a secret setting: no backup, export or audit row ever holds them. */
export const CLOUD_KEY = 'cloud.credentials';

export const readCloud = (database: Database, ctx: Ctx): Promise<CloudSettings | undefined> =>
  new SettingsRepo(database).getValue<CloudSettings>(ctx, CLOUD_KEY);

/** After a backup, copy it to the person's own drive if they switched that on. Never throws. */
export async function cloudUploadIfEnabled(
  database: Database,
  ctx: Ctx,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const c = await readCloud(database, ctx);
    if (!c?.enabled) return;
    await uploadBackup(c, name, bytes);
    writeStatus({ cloudAt: Date.now(), cloudError: null });
  } catch (e) {
    writeStatus({ cloudError: e instanceof Error ? e.message : String(e) });
  }
}
