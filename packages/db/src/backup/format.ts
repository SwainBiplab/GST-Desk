/**
 * The `.gstbk` file: a ZIP with a manifest, one JSON-lines file per table and the attachment files.
 *
 *   manifest.json            what is inside, the schema version it was made at, a checksum per file
 *   data/<table>.jsonl       one JSON object per line, rows in primary-key order
 *   attachments/<sha256>     the bytes of each attached file, named by their hash
 *
 * Plain files in a standard container, so a person can open one with any unzip tool and read it.
 * Written and read the same way in the browser, in Node and in the desktop app.
 */

export const BACKUP_FORMAT = 'gstbk';
export const BACKUP_FORMAT_VERSION = 1;
/** The file name extension of a backup. */
export const BACKUP_EXTENSION = '.gstbk';

export interface ManifestTable {
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ManifestAttachment {
  sha256: string;
  bytes: number;
  file: string;
}

export interface ManifestBusiness {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** ISO time the backup was made. */
  createdAt: string;
  /** Number of migrations the database had applied: a backup is restored by an app at least this new. */
  schemaVersion: number;
  dialect: 'sqlite' | 'pg';
  app: string;
  businesses: ManifestBusiness[];
  tables: Record<string, ManifestTable>;
  attachments: ManifestAttachment[];
  /** Attachments the database knows about whose bytes could not be read when the backup was made. */
  missingAttachments: string[];
  totals: { rows: number; attachments: number };
}

export type BackupKind = 'auto' | 'manual' | 'pre-migration';

/**
 * `auto-20250301T093000Z.gstbk`: what made it, then when (UTC), so names sort by time and carry no
 * character a file system dislikes.
 */
export function backupFileName(at: Date, kind: BackupKind = 'auto'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${kind}-${p(at.getUTCFullYear(), 4)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `T${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z${BACKUP_EXTENSION}`
  );
}

const NAME = /^(auto|manual|pre-migration)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.gstbk$/;

/** What kind of backup a file name stands for, or null if the name is not one of ours. */
export function backupKindOf(name: string): BackupKind | null {
  const m = NAME.exec(name);
  return m ? (m[1] as BackupKind) : null;
}

/** The time a backup file name stands for, or null if the name is not one of ours. */
export function backupTimeOf(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}
