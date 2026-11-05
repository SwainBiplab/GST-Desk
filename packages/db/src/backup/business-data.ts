/**
 * One business's data as a unit: read it from a database or a backup, write it out as JSON or CSV, and
 * bring it into another database as a new business. Every id is replaced by a new one on the way in
 * (and every reference to it, including ids kept inside JSON settings), so the same data can be
 * imported into the install it came from, or into a different one, without a clash.
 */
import { toCsv, type CsvValue } from '@gst/domain';
import { sql } from 'drizzle-orm';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';

import type { Database } from '../database';
import { schemaVersion } from '../migrate';
import { newId } from '../repositories/base';

import { readTable } from './export';
import type { AttachmentSource } from './export';
import { insertRows, orderForInsert } from './insert';
import { BackupError, rowChunks, type Verification } from './read';
import {
  TABLES,
  assertSqlite,
  isSecretSettingKey,
  sanitizeIncoming,
  scrubAudit,
  tableInfo,
  tableOrder,
  toPortable,
  utf8,
  type TableInfo,
} from './tables';

/** What belongs to a device or a login, not to the business: left out of a business's data. */
const NOT_BUSINESS_DATA = new Set([
  'organisations',
  'users',
  'memberships',
  'devices',
  'number_reservations',
  'sync_state',
  'ai_calls',
  'hsn_master',
  'rate_master_versions',
]);
/** The trail of who changed what is big and belongs to its install: only on request. */
const OPTIONAL = new Set(['audit_log']);

export interface BusinessData {
  business: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

export const businessTables = (includeAudit = false): TableInfo[] =>
  TABLES.filter(
    (t) =>
      t.name !== 'businesses' &&
      'business_id' in t.columns &&
      !NOT_BUSINESS_DATA.has(t.name) &&
      (includeAudit || !OPTIONAL.has(t.name)),
  );

/* ------------------------------------------------------------------ reading */

export async function readBusinessData(
  d: Database,
  businessId: string,
  opts: { includeAudit?: boolean } = {},
): Promise<BusinessData> {
  assertSqlite(d);
  const biz: Record<string, unknown>[] = [];
  for await (const chunk of readTable(d, 'businesses', 10, sql`id = ${businessId}`))
    biz.push(...chunk);
  if (biz.length === 0)
    throw new BackupError('not_a_backup', 'That business is not in this database.');
  const tables: BusinessData['tables'] = {};
  for (const t of businessTables(opts.includeAudit)) {
    const rows: Record<string, unknown>[] = [];
    for await (const chunk of readTable(d, t.name, 1000, sql`business_id = ${businessId}`)) {
      for (const raw of chunk) {
        if (t.name === 'settings' && isSecretSettingKey(String(raw['key'] ?? ''))) continue;
        rows.push(t.name === 'audit_log' ? scrubAudit(toPortable(t, raw)) : toPortable(t, raw));
      }
    }
    tables[t.name] = rows;
  }
  return { business: toPortable(tableInfo('businesses'), biz[0]!), tables };
}

/** One business out of a full backup (the restore-one-business path). */
export function businessDataFromBackup(
  bytes: Uint8Array,
  verification: Pick<Verification, 'manifest'>,
  businessId: string,
  opts: { includeAudit?: boolean } = {},
): BusinessData {
  const { manifest } = verification;
  let business: Record<string, unknown> | null = null;
  for (const c of rowChunks(bytes, manifest, 'businesses', 1000))
    for (const r of c) if (r['id'] === businessId) business = r;
  if (!business) throw new BackupError('not_a_backup', 'That business is not in this backup.');
  const tables: BusinessData['tables'] = {};
  for (const t of businessTables(opts.includeAudit)) {
    const rows: Record<string, unknown>[] = [];
    for (const c of rowChunks(bytes, manifest, t.name, 2000))
      for (const r of c)
        if (
          r['business_id'] === businessId &&
          !(t.name === 'settings' && isSecretSettingKey(String(r['key'])))
        )
          rows.push(r);
    tables[t.name] = sanitizeIncoming(t.name, rows);
  }
  return { business, tables };
}

/* ------------------------------------------------------------------ JSON */

export const EXPORT_FORMAT = 'gst-desk-export';
export const EXPORT_FORMAT_VERSION = 1;

/**
 * The business as one JSON document (documented in `docs/export-schema.md`): the business, then each
 * table's rows, with a document's lines and a payment's allocations inside it. No secrets.
 */
export async function exportBusinessJson(
  d: Database,
  businessId: string,
  opts: { includeAudit?: boolean; now?: () => Date } = {},
): Promise<string> {
  const data = await readBusinessData(d, businessId, opts);
  const out: Record<string, unknown> = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: (opts.now ?? (() => new Date()))().toISOString(),
    schemaVersion: await schemaVersion(d),
    business: data.business,
  };
  const tables: Record<string, unknown> = {};
  const nest = (parent: string, child: string, key: string, as: string) => {
    const kids = data.tables[child] ?? [];
    const by = new Map<string, Record<string, unknown>[]>();
    for (const k of kids) {
      const id = String(k[key]);
      by.set(id, [...(by.get(id) ?? []), k]);
    }
    tables[parent] = (data.tables[parent] ?? []).map((p) => ({
      ...p,
      [as]: by.get(String(p['id'])) ?? [],
    }));
  };
  nest('documents', 'document_lines', 'document_id', 'lines');
  nest('payments', 'payment_allocations', 'payment_id', 'allocations');
  // allocations that belong to no payment (credit applied between documents) stay in their own list
  const loose = (data.tables['payment_allocations'] ?? []).filter((a) => a['payment_id'] == null);
  if (loose.length) tables['payment_allocations'] = loose;
  for (const [name, rows] of Object.entries(data.tables)) {
    if (name === 'document_lines' || name === 'documents' || name === 'payments') continue;
    if (name === 'payment_allocations') continue;
    tables[name] = rows;
  }
  out['tables'] = tables;
  return JSON.stringify(out, null, 1);
}

/** Read an export back into rows. Throws `BackupError` for anything that is not one of ours. */
export function parseExportJson(text: string): BusinessData {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BackupError('not_a_backup', 'This file is not a GST Desk export.');
  }
  if (doc['format'] !== EXPORT_FORMAT || typeof doc['business'] !== 'object' || !doc['tables'])
    throw new BackupError('not_a_backup', 'This file is not a GST Desk export.');
  if (Number(doc['formatVersion']) > EXPORT_FORMAT_VERSION)
    throw new BackupError(
      'unsupported_version',
      'This export was made by a newer version of GST Desk. Update the app and try again.',
    );
  const raw = doc['tables'] as Record<string, Record<string, unknown>[]>;
  const tables: BusinessData['tables'] = {};
  const known = new Set(TABLES.map((t) => t.name));
  for (const [name, rows] of Object.entries(raw)) {
    if (!known.has(name) || !Array.isArray(rows)) continue;
    const flat: Record<string, unknown>[] = [];
    for (const r of rows) {
      const { lines, allocations, ...own } = r as Record<string, unknown> & {
        lines?: Record<string, unknown>[];
        allocations?: Record<string, unknown>[];
      };
      flat.push(own);
      if (name === 'documents' && Array.isArray(lines))
        tables['document_lines'] = [...(tables['document_lines'] ?? []), ...lines];
      if (name === 'payments' && Array.isArray(allocations))
        tables['payment_allocations'] = [...(tables['payment_allocations'] ?? []), ...allocations];
    }
    tables[name] = [...(tables[name] ?? []), ...flat];
  }
  for (const name of Object.keys(tables)) tables[name] = sanitizeIncoming(name, tables[name]!);
  return { business: doc['business'] as Record<string, unknown>, tables };
}

/* ------------------------------------------------------------------ CSV */

function csvValue(col: TableInfo['columns'][string], v: unknown): CsvValue {
  if (v === null || v === undefined) return '';
  if (col.kind === 'json') return JSON.stringify(v);
  if (col.kind === 'bool') return v ? 'true' : 'false';
  if (col.kind === 'big' || col.kind === 'int' || col.kind === 'ts') return { numeric: String(v) };
  return String(v);
}

/**
 * A ZIP of one CSV per table (every column, in the schema's order, text neutralised so a spreadsheet
 * will not run it) and the attached files. For people who want to open the data in a spreadsheet.
 */
export async function exportCsvBundle(
  d: Database,
  businessId: string,
  opts: { attachments?: AttachmentSource; includeAudit?: boolean; now?: () => Date } = {},
): Promise<Uint8Array> {
  const data = await readBusinessData(d, businessId, opts);
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, c) => {
    if (!err) chunks.push(c);
  });
  const put = (name: string, bytes: Uint8Array, compress = true) => {
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(f);
    f.push(bytes, true);
  };
  const tableCsv = (t: TableInfo, rows: Record<string, unknown>[]) => {
    const cols = Object.keys(t.columns);
    return toCsv([cols, ...rows.map((r) => cols.map((c) => csvValue(t.columns[c]!, r[c])))]);
  };
  put('businesses.csv', utf8(tableCsv(tableInfo('businesses'), [data.business])));
  const counts: Record<string, number> = { businesses: 1 };
  for (const t of businessTables(opts.includeAudit)) {
    const rows = data.tables[t.name] ?? [];
    counts[t.name] = rows.length;
    put(`${t.name}.csv`, utf8(tableCsv(t, rows)));
  }
  let files = 0;
  if (opts.attachments) {
    const seen = new Set<string>();
    for (const a of data.tables['attachments'] ?? []) {
      const sha = String(a['sha256']);
      if (seen.has(sha)) continue;
      seen.add(sha);
      const bytes = await opts.attachments.read(String(a['storage_path']));
      if (!bytes) continue;
      const safe = String(a['file_name']).replace(/[^\p{L}\p{N}._-]+/gu, '_');
      put(`attachments/${sha.slice(0, 12)}-${safe}`, bytes, false);
      files += 1;
    }
  }
  put(
    'README.txt',
    strToU8(
      'One CSV file per table, with every column of the GST Desk schema (docs/export-schema.md).\n' +
        'Amounts are in paise and quantities in millionths of a unit, as stored.\n' +
        'JSON columns are written as JSON text. No passwords, tokens or PINs are included.\n',
    ),
  );
  put('counts.json', strToU8(JSON.stringify({ rows: counts, attachments: files }, null, 1)));
  zip.end();
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ------------------------------------------------------------------ import */

export interface ImportOptions {
  /** The organisation and the person the new business belongs to. */
  orgId: string;
  actor: string;
  /** Count what would be imported and write nothing. */
  dryRun?: boolean;
  /** The new business's name; defaults to the original's with "(imported)" after it. */
  name?: string;
  includeAudit?: boolean;
  onProgress?: (p: { stage: string; done: number; total: number }) => void;
}

export interface ImportResult {
  businessId: string;
  dryRun: boolean;
  tables: Record<string, number>;
  rows: number;
  /** Ids that were replaced. */
  idsMapped: number;
  warnings: string[];
}

class DryRunDone extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace every string in a value that is one of the old ids with the new one. */
function remapDeep(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapDeep(v, map));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapDeep(v, map)]));
  return value;
}

/**
 * Bring a business in as a new one. New ids for everything, references and ids inside JSON settings
 * followed to the new ids, the change history stamped with the importing person, all in one
 * transaction. With `dryRun` the same work is done and rolled back, so the counts are exactly what a
 * real import would write.
 */
export async function importBusinessData(
  d: Database,
  data: BusinessData,
  opts: ImportOptions,
): Promise<ImportResult> {
  assertSqlite(d);
  // whatever the data came from, it is cleaned again here: this is the last step before it is written
  data = {
    business: data.business,
    tables: Object.fromEntries(
      Object.entries(data.tables).map(([n, rows]) => [n, sanitizeIncoming(n, rows)]),
    ),
  };
  const warnings: string[] = [];
  const oldBusinessId = String(data.business['id']);
  const businessId = newId();
  const map = new Map<string, string>();
  map.set(oldBusinessId, businessId);
  const included = businessTables(opts.includeAudit);
  const have = new Set(included.map((t) => t.name));
  for (const rows of Object.values(data.tables))
    for (const r of rows) map.set(String(r['id']), newId());
  const idsMapped = map.size;

  const mapRow = (t: TableInfo, row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(t.columns)) {
      if (!(k in row)) continue;
      let v = row[k];
      if (v !== null && v !== undefined) {
        if (k === 'id') v = map.get(String(v)) ?? newId();
        else if (k === 'org_id') v = opts.orgId;
        else if (k === 'business_id') v = businessId;
        else if (k === 'created_by' || k === 'updated_by') v = opts.actor;
        else if (col.kind === 'json') v = remapDeep(v, map);
        else if (col.kind === 'uuid' || (typeof v === 'string' && col.o.ref)) {
          const mapped = map.get(String(v));
          if (mapped) v = mapped;
          else if (col.o.ref) {
            // points at something that is not part of this data (a deleted row, another install)
            if (col.o.nn)
              throw new BackupError(
                'not_a_backup',
                `${t.name}.${k} points at ${String(v)}, which is not in this data.`,
              );
            warnings.push(`${t.name}.${k}: a reference to something not in this data was cleared`);
            v = null;
          }
        } else if (
          t.name === 'audit_log' &&
          k === 'row_id' &&
          typeof v === 'string' &&
          UUID.test(v)
        ) {
          v = map.get(v) ?? v;
        }
      }
      out[k] = v;
    }
    return out;
  };

  const tables: Record<string, number> = {};
  let rows = 0;
  const run = async () => {
    await d.db.transaction(async (tx: any) => {
      await tx.run(sql.raw('PRAGMA defer_foreign_keys = ON'));
      // the business first, under its new name
      const bizInfo = tableInfo('businesses');
      const biz = mapRow(bizInfo, data.business);
      const legal = String(data.business['legal_name'] ?? 'Business');
      biz['legal_name'] = opts.name?.trim() || `${legal} (imported)`;
      // the name people see in the business switcher is the trade name, when there is one
      if (opts.name?.trim()) biz['trade_name'] = opts.name.trim();
      else if (data.business['trade_name'])
        biz['trade_name'] = `${String(data.business['trade_name'])} (imported)`;
      await insertRows(d, tx, bizInfo, [biz]);
      tables['businesses'] = 1;
      rows += 1;
      for (const name of tableOrder()) {
        if (!have.has(name)) continue;
        const info = tableInfo(name);
        const src = data.tables[name] ?? [];
        if (src.length === 0) {
          tables[name] = 0;
          continue;
        }
        const mapped = orderForInsert(
          info,
          src.map((r) => mapRow(info, r)),
        );
        const n = await insertRows(d, tx, info, mapped);
        tables[name] = n;
        rows += n;
        opts.onProgress?.({ stage: name, done: n, total: src.length });
      }
      if (opts.dryRun) throw new DryRunDone();
    });
  };
  try {
    await run();
  } catch (e) {
    if (!(e instanceof DryRunDone)) throw e;
  }
  return {
    businessId,
    dryRun: !!opts.dryRun,
    tables,
    rows,
    idsMapped,
    warnings: [...new Set(warnings)],
  };
}
