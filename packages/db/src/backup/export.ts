import { sql, type SQL } from 'drizzle-orm';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';

import { queryRows, type Database } from '../database';
import { schemaVersion } from '../migrate';

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type ManifestAttachment,
  type ManifestTable,
} from './format';
import {
  TABLES,
  assertSqlite,
  isSecretSettingKey,
  scrubAudit,
  sha256Hex,
  toPortable,
  utf8,
} from './tables';

/** Where the bytes of attached files are read from (the browser's file store, the desktop's folder). */
export interface AttachmentSource {
  /** The bytes behind an attachment's `storage_path`, or null if they are gone. */
  read(storagePath: string): Promise<Uint8Array | null>;
}

export interface BackupProgress {
  /** A table name, or `attachments`. */
  stage: string;
  done: number;
  total: number;
}

export interface BackupOptions {
  attachments?: AttachmentSource;
  onProgress?: (p: BackupProgress) => void;
  /** Called between chunks so the page can draw and take input. Defaults to a macrotask yield. */
  yieldToUi?: () => Promise<void>;
  now?: () => Date;
  app?: string;
  /** Rows read per query. */
  chunkRows?: number;
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Rows are read in key order, a chunk at a time, so memory holds one chunk and not the table. `where`
 * narrows them (one business's rows); it is a SQL condition on the table's own columns.
 */
export async function* readTable(
  d: Database,
  table: string,
  chunkRows = 1000,
  where?: SQL,
): AsyncGenerator<Record<string, unknown>[]> {
  let last: string | null = null;
  const scope = where ? sql` AND (${where})` : sql``;
  for (;;) {
    const rows: Record<string, unknown>[] = await queryRows(
      d,
      d.db,
      last === null
        ? sql`SELECT * FROM ${sql.identifier(table)} WHERE 1 = 1${scope} ORDER BY id LIMIT ${chunkRows}`
        : sql`SELECT * FROM ${sql.identifier(table)} WHERE id > ${last}${scope} ORDER BY id LIMIT ${chunkRows}`,
    );
    if (rows.length === 0) return;
    yield rows;
    last = String(rows[rows.length - 1]!['id']);
    if (rows.length < chunkRows) return;
  }
}

export async function countRows(d: Database, table: string): Promise<number> {
  const r = await queryRows(d, d.db, sql`SELECT count(*) AS c FROM ${sql.identifier(table)}`);
  return Number(r[0]?.['c'] ?? 0);
}

/**
 * Make a backup of everything in the database: every business, with its documents, parties, items,
 * payments, settings, templates and audit trail, and the attached files. Secrets (tokens, PINs) are
 * left out. The database is only read; this can run while the app is in use.
 */
export async function createBackup(
  d: Database,
  opts: BackupOptions = {},
): Promise<{ bytes: Uint8Array; manifest: BackupManifest }> {
  assertSqlite(d);
  const now = (opts.now ?? (() => new Date()))();
  const yieldToUi = opts.yieldToUi ?? defaultYield;
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else chunks.push(data);
  });
  const add = async (name: string, bytes: Uint8Array, compress: boolean) => {
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    file.mtime = now.getTime();
    zip.add(file);
    const slice = 1 << 18;
    for (let at = 0; at < bytes.length; at += slice) {
      file.push(bytes.subarray(at, Math.min(bytes.length, at + slice)), at + slice >= bytes.length);
      if ((at / slice) % 8 === 7) await yieldToUi();
    }
    if (bytes.length === 0) file.push(new Uint8Array(0), true);
    if (failure) throw failure;
  };

  const tables: Record<string, ManifestTable> = {};
  let rowTotal = 0;
  const attachmentRows: { sha256: string; storage_path: string }[] = [];

  for (const t of TABLES) {
    const total = await countRows(d, t.name);
    // each chunk is encoded as it is read, so there is never one giant string for a whole table
    const pieces: Uint8Array[] = [];
    let size = 0;
    let rows = 0;
    for await (const batch of readTable(d, t.name, opts.chunkRows ?? 1000)) {
      const lines: string[] = [];
      for (const raw of batch) {
        if (t.name === 'settings' && isSecretSettingKey(String(raw['key'] ?? ''))) continue;
        const portable =
          t.name === 'audit_log' ? scrubAudit(toPortable(t, raw)) : toPortable(t, raw);
        if (t.name === 'attachments')
          attachmentRows.push({
            sha256: String(portable['sha256']),
            storage_path: String(portable['storage_path']),
          });
        lines.push(JSON.stringify(portable));
        rows += 1;
      }
      if (lines.length) {
        const piece = utf8(`${lines.join('\n')}\n`);
        pieces.push(piece);
        size += piece.length;
      }
      opts.onProgress?.({ stage: t.name, done: rows, total });
      await yieldToUi();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.length;
    }
    const file = `data/${t.name}.jsonl`;
    tables[t.name] = { file, rows, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    await add(file, bytes, true);
    rowTotal += rows;
  }

  // the files that rows point at: each once, named by its hash
  const attachments: ManifestAttachment[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  if (opts.attachments) {
    let done = 0;
    for (const a of attachmentRows) {
      done += 1;
      if (seen.has(a.sha256)) continue;
      seen.add(a.sha256);
      const bytes = await opts.attachments.read(a.storage_path);
      if (!bytes) {
        missing.push(a.sha256);
        continue;
      }
      const file = `attachments/${a.sha256}`;
      attachments.push({ sha256: await sha256Hex(bytes), bytes: bytes.length, file });
      // a file stored under its own hash is written under that hash, so a damaged copy shows up
      if (attachments[attachments.length - 1]!.sha256 !== a.sha256) {
        attachments.pop();
        missing.push(a.sha256);
        continue;
      }
      await add(file, bytes, false);
      opts.onProgress?.({ stage: 'attachments', done, total: attachmentRows.length });
      await yieldToUi();
    }
  } else {
    for (const a of attachmentRows) if (!seen.has(a.sha256)) missing.push(a.sha256);
  }

  const businesses = await readBusinessList(d);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    schemaVersion: await schemaVersion(d),
    dialect: d.dialect,
    app: opts.app ?? 'gst-desk',
    businesses,
    tables,
    attachments,
    missingAttachments: [...new Set(missing)],
    totals: { rows: rowTotal, attachments: attachments.length },
  };
  await add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)), true);
  zip.end();
  if (failure) throw failure;

  let size = 0;
  for (const c of chunks) size += c.length;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, manifest };
}

async function readBusinessList(d: Database): Promise<BackupManifest['businesses']> {
  const rows = await queryRows(
    d,
    d.db,
    sql`SELECT id, legal_name, trade_name, gstin FROM businesses WHERE deleted_at IS NULL ORDER BY created_at, id`,
  );
  return rows.map((r) => ({
    id: String(r['id']),
    legalName: String(r['legal_name']),
    tradeName: r['trade_name'] == null ? null : String(r['trade_name']),
    gstin: r['gstin'] == null ? null : String(r['gstin']),
  }));
}
