import { sql } from 'drizzle-orm';

import { execRaw, queryRows, type Database } from '../database';
import { schemaVersion } from '../migrate';

import type { BackupManifest } from './format';
import { insertRows, orderForInsert } from './insert';
import { BackupError, entryOf, rowChunksAsync, verifyBackup, type Verification } from './read';
import { TABLES, assertSqlite, sanitizeIncoming, tableInfo, tableOrder } from './tables';

/** Where restored attached files go (the browser's file store, the desktop's folder). */
export interface AttachmentSink {
  write(sha256: string, bytes: Uint8Array): Promise<void>;
}

export interface RestoreOptions {
  attachments?: AttachmentSink;
  onProgress?: (p: { stage: string; done: number; total: number }) => void;
  yieldToUi?: () => Promise<void>;
  /**
   * Called after each batch is inserted. Used to stop the process half way in the chaos test; a throw
   * here abandons the restore like any other failure.
   */
  onBatch?: (table: string, rowsSoFar: number) => void | Promise<void>;
}

export interface RestoreResult {
  tables: Record<string, number>;
  rows: number;
  attachments: number;
  /** Rows left out because they held a secret (a backup made by this app never has any). */
  secretsDropped: number;
}

export interface Preflight {
  ok: boolean;
  manifest: BackupManifest | null;
  problems: string[];
  warnings: string[];
  /** The backup was made by an app with more migrations than this one has. */
  newerThanApp: boolean;
}

/**
 * What a restore needs to know before it starts: the file is a backup, it is whole (checksums), and
 * this app is new enough to read it. Nothing is written.
 */
export async function preflightBackup(
  bytes: Uint8Array,
  currentSchemaVersion: number,
): Promise<Preflight> {
  let v: Verification;
  try {
    v = await verifyBackup(bytes);
  } catch (e) {
    return {
      ok: false,
      manifest: null,
      problems: [e instanceof Error ? e.message : String(e)],
      warnings: [],
      newerThanApp: e instanceof BackupError && e.code === 'unsupported_version',
    };
  }
  const newer = v.manifest.schemaVersion > currentSchemaVersion;
  const problems = [...v.problems];
  if (newer)
    problems.push(
      'This backup was made by a newer version of GST Desk than this one. Update the app and try again.',
    );
  return {
    ok: problems.length === 0,
    manifest: v.manifest,
    problems,
    warnings: v.warnings,
    newerThanApp: newer,
  };
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Put a backup into an empty, migrated database, all or nothing: the rows go in one transaction, the
 * counts are checked against the backup's own list, and the finished database is checked for
 * integrity. Any failure rolls the transaction back and throws; the caller throws the staging
 * database away and the live one was never touched.
 */
export async function restoreAll(
  target: Database,
  bytes: Uint8Array,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  assertSqlite(target);
  const current = await schemaVersion(target);
  // verifying throws with the reason (not a backup, from a newer app, damaged) before anything is written
  const yieldToUi = opts.yieldToUi ?? yieldNow;
  const verified = await verifyBackup(bytes, yieldToUi);
  if (verified.problems.length > 0)
    throw new BackupError('corrupt', verified.problems[0]!, verified.problems);
  if (verified.manifest.schemaVersion > current)
    throw new BackupError(
      'newer_schema',
      'This backup was made by a newer version of GST Desk than this one. Update the app and try again.',
    );
  const pre = { manifest: verified.manifest };
  const manifest = pre.manifest;

  const existing = await queryRows(target, target.db, sql`SELECT count(*) AS c FROM organisations`);
  if (Number(existing[0]?.['c'] ?? 0) > 0)
    throw new BackupError(
      'target_not_empty',
      'A backup is restored into an empty database, never over data in use.',
    );

  // files first: they are named by their hash, so writing one twice is harmless
  let attachments = 0;
  if (opts.attachments) {
    for (const a of manifest.attachments) {
      const raw = entryOf(bytes, a.file);
      if (!raw) throw new BackupError('corrupt', `attachment ${a.sha256.slice(0, 8)} is missing`);
      await opts.attachments.write(a.sha256, raw);
      attachments += 1;
      opts.onProgress?.({
        stage: 'attachments',
        done: attachments,
        total: manifest.attachments.length,
      });
      await yieldToUi();
    }
  }

  const known = new Set(TABLES.map((t) => t.name));
  const result: RestoreResult = { tables: {}, rows: 0, attachments, secretsDropped: 0 };
  await target.db.transaction(async (tx: any) => {
    await execRaw(target, tx, 'PRAGMA defer_foreign_keys = ON');
    for (const name of tableOrder()) {
      const entry = manifest.tables[name];
      if (!entry || !known.has(name)) continue;
      const info = tableInfo(name);
      let inserted = 0;
      // rows that were left out because they carry a secret, which still count towards the backup's list
      let dropped = 0;
      // a table that points at itself is inserted whole so its rows can be put in order
      const selfRef = Object.values(info.refs).includes(name);
      const pending: Record<string, unknown>[] = [];
      for await (const raw of rowChunksAsync(bytes, manifest, name, 500, yieldToUi)) {
        const chunk = sanitizeIncoming(name, raw);
        dropped += raw.length - chunk.length;
        if (selfRef) pending.push(...chunk);
        else {
          inserted += await insertRows(target, tx, info, chunk);
          await opts.onBatch?.(name, inserted);
          opts.onProgress?.({ stage: name, done: inserted, total: entry.rows });
          await yieldToUi();
        }
      }
      if (selfRef) {
        inserted += await insertRows(target, tx, info, orderForInsert(info, pending), yieldToUi);
        await opts.onBatch?.(name, inserted);
      }
      result.secretsDropped += dropped;
      if (inserted + dropped !== entry.rows)
        throw new BackupError(
          'row_count_mismatch',
          `${name}: restored ${inserted} of ${entry.rows} rows`,
        );
      result.tables[name] = inserted;
      result.rows += inserted;
    }
  });

  await checkSqliteIntegrity(target);
  return result;
}

/** Whole-database checks after a restore. Throws if the file is damaged or a reference is dangling. */
export async function checkSqliteIntegrity(d: Database): Promise<void> {
  const integrity = await queryRows(d, d.db, sql`PRAGMA integrity_check`);
  const verdict = String(Object.values(integrity[0] ?? {})[0] ?? '');
  if (verdict !== 'ok')
    throw new BackupError('integrity', `The database failed its integrity check: ${verdict}`);
  const dangling = await queryRows(d, d.db, sql`PRAGMA foreign_key_check`);
  if (dangling.length > 0)
    throw new BackupError(
      'integrity',
      `${dangling.length} row(s) point at something that is not there`,
      dangling.slice(0, 5).map((r) => `${String(r['table'])} → ${String(r['parent'])}`),
    );
}
