import { Unzip, UnzipInflate, strFromU8, unzipSync } from 'fflate';

import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type BackupManifest } from './format';
import { TABLES, sha256Hex } from './tables';

export type BackupErrorCode =
  | 'not_a_backup'
  | 'unsupported_version'
  | 'newer_schema'
  | 'corrupt'
  | 'target_not_empty'
  | 'row_count_mismatch'
  | 'integrity';

export class BackupError extends Error {
  override name = 'BackupError';
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

const decoder = new TextDecoder();

/** One file out of the archive, unpacked alone so memory holds that file and not the whole backup. */
export function entryOf(bytes: Uint8Array, name: string): Uint8Array | null {
  const found = unzipSync(bytes, { filter: (f) => f.name === name });
  return found[name] ?? null;
}

/** Read and check the manifest. Throws `BackupError` if this is not a backup this app understands. */
export function readManifest(bytes: Uint8Array): BackupManifest {
  let raw: Uint8Array | null;
  try {
    raw = entryOf(bytes, 'manifest.json');
  } catch {
    throw new BackupError('not_a_backup', 'This file is not a GST Desk backup.');
  }
  if (!raw) throw new BackupError('not_a_backup', 'This file is not a GST Desk backup.');
  let m: Partial<BackupManifest>;
  try {
    m = JSON.parse(strFromU8(raw)) as Partial<BackupManifest>;
  } catch {
    throw new BackupError('corrupt', 'The backup’s contents list cannot be read.');
  }
  if (m.format !== BACKUP_FORMAT || !m.tables || typeof m.schemaVersion !== 'number')
    throw new BackupError('not_a_backup', 'This file is not a GST Desk backup.');
  if (typeof m.formatVersion !== 'number' || m.formatVersion > BACKUP_FORMAT_VERSION)
    throw new BackupError(
      'unsupported_version',
      'This backup was made by a newer version of GST Desk. Update the app and try again.',
    );
  return m as BackupManifest;
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

/** Below this many bytes unpacked, the page is not held long enough to matter. */
const SMALL_FILE = 4 * 1024 * 1024;

/**
 * One compressed table out of the archive, unpacked a slice at a time with a pause between slices, so
 * a table of a hundred megabytes does not hold the page still while it is inflated. (Attached files are
 * stored, not compressed, and are read with `entryOf`.)
 */
export async function entryAsync(
  bytes: Uint8Array,
  name: string,
  yieldToUi: () => Promise<void> = defaultYield,
  /** The file's size once unpacked, if known: a small file is unpacked at once, the way `entryOf` does. */
  sizeHint?: number,
): Promise<Uint8Array | null> {
  if (sizeHint !== undefined && sizeHint <= SMALL_FILE) return entryOf(bytes, name);
  const parts: Uint8Array[] = [];
  let found = false;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (file.name !== name) return;
    found = true;
    file.ondata = (err, chunk) => {
      if (err) failure = err;
      else parts.push(chunk);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const slice = 1 << 18;
  for (let at = 0; at < bytes.length; at += slice) {
    unzip.push(bytes.subarray(at, Math.min(bytes.length, at + slice)), at + slice >= bytes.length);
    if (failure) throw failure;
    if ((at / slice) % 4 === 3) await yieldToUi();
  }
  if (!found) return null;
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface Verification {
  manifest: BackupManifest;
  problems: string[];
  warnings: string[];
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n').filter(Boolean));

/**
 * Check a backup without touching any database: every file the manifest lists is there, its hash
 * and size are right, and a table holds the number of rows the manifest says. A backup that fails is
 * never restored.
 */
export async function verifyBackup(
  bytes: Uint8Array,
  yieldToUi?: () => Promise<void>,
): Promise<Verification> {
  const manifest = readManifest(bytes);
  const problems: string[] = [];
  const warnings: string[] = [];
  const known = new Set(TABLES.map((t) => t.name));
  for (const [name, t] of Object.entries(manifest.tables)) {
    if (!known.has(name)) {
      warnings.push(
        `The backup has a table this version does not know: ${name}. Its rows are skipped.`,
      );
      continue;
    }
    let raw: Uint8Array | null;
    try {
      raw = await entryAsync(bytes, t.file, yieldToUi, t.bytes);
    } catch {
      problems.push(`${name}: the data cannot be unpacked`);
      continue;
    }
    if (!raw) {
      problems.push(`${name}: the file ${t.file} is missing`);
      continue;
    }
    if (raw.length !== t.bytes || (await sha256Hex(raw)) !== t.sha256) {
      problems.push(`${name}: the data does not match its checksum`);
      continue;
    }
    if (linesOf(decoder.decode(raw)).length !== t.rows)
      problems.push(`${name}: expected ${t.rows} rows`);
  }
  for (const name of known) {
    if (!(name in manifest.tables))
      warnings.push(`The backup has no ${name} table: it starts empty.`);
  }
  for (const a of manifest.attachments) {
    const raw = entryOf(bytes, a.file);
    if (!raw) problems.push(`attachment ${a.sha256.slice(0, 8)}: the file is missing`);
    else if ((await sha256Hex(raw)) !== a.sha256)
      problems.push(`attachment ${a.sha256.slice(0, 8)}: the file does not match its checksum`);
  }
  if (manifest.missingAttachments.length > 0)
    warnings.push(
      `${manifest.missingAttachments.length} attached file(s) could not be copied when this backup was made.`,
    );
  return { manifest, problems, warnings };
}

/** The rows of one table in the backup, a chunk at a time. */
export function* rowChunks(
  bytes: Uint8Array,
  manifest: BackupManifest,
  table: string,
  chunk = 500,
): Generator<Record<string, unknown>[]> {
  const t = manifest.tables[table];
  if (!t) return;
  const raw = entryOf(bytes, t.file);
  if (!raw) return;
  const lines = linesOf(decoder.decode(raw));
  for (let at = 0; at < lines.length; at += chunk) {
    yield lines.slice(at, at + chunk).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

/** Every row of one table (for small tables and for tests). */
export function allRows(
  bytes: Uint8Array,
  manifest: BackupManifest,
  table: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of rowChunks(bytes, manifest, table, 5000)) out.push(...c);
  return out;
}

/** The rows of one table, a chunk at a time, unpacking and parsing in slices that let the page run. */
export async function* rowChunksAsync(
  bytes: Uint8Array,
  manifest: BackupManifest,
  table: string,
  chunk = 500,
  yieldToUi?: () => Promise<void>,
): AsyncGenerator<Record<string, unknown>[]> {
  const t = manifest.tables[table];
  if (!t) return;
  const raw = await entryAsync(bytes, t.file, yieldToUi, t.bytes);
  if (!raw) return;
  const text = decoder.decode(raw);
  let from = 0;
  while (from < text.length) {
    // the next `chunk` lines, found one at a time rather than splitting the whole table up front
    let end = from;
    let n = 0;
    while (n < chunk && end < text.length) {
      const nl = text.indexOf('\n', end);
      end = nl === -1 ? text.length : nl + 1;
      n += 1;
    }
    const rows = text
      .slice(from, end)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (rows.length) yield rows;
    from = end;
  }
}
