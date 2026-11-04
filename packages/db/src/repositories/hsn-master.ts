/**
 * The HSN/SAC master as versioned reference data: history-keeping import, rate lookup by date, and
 * the resolver that items use to tell whether their GST rate follows the master.
 */
import {
  compareVersions,
  planHsnImport,
  rowAsOf,
  type HsnRateChange,
  type HsnRow,
} from '@gst/domain';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../database';
import { flushWrites, noteWrite } from '../events';

import { newId } from './base';

type AnyRow = Record<string, any>;

const toHsnRow = (r: AnyRow): HsnRow => ({
  code: String(r['code']),
  description: String(r['description']),
  rate_bp: Number(r['rate_bp']),
  cess_bp: Number(r['cess_bp']),
  effective_from: String(r['effective_from']),
  effective_to: r['effective_to'] ? String(r['effective_to']) : null,
});

/** Rates by code, with history. A code that is not listed falls back to its 6 then 4 digit heading. */
export class HsnResolver {
  private readonly byCode = new Map<string, HsnRow[]>();

  constructor(rows: Iterable<HsnRow>) {
    for (const r of rows) {
      const list = this.byCode.get(r.code) ?? [];
      list.push(r);
      this.byCode.set(r.code, list);
    }
  }

  private history(code: string): HsnRow[] {
    for (const len of new Set([code.length, 6, 4])) {
      if (len > code.length) continue;
      const h = this.byCode.get(code.slice(0, len));
      if (h) return h;
    }
    return [];
  }

  /** The row in force on `asOf`. */
  resolve(code: string, asOf: string): HsnRow | null {
    return rowAsOf(this.history(code), asOf);
  }

  /** The next row that starts after `asOf`, when a change is already published. */
  upcoming(code: string, asOf: string): HsnRow | null {
    return (
      this.history(code)
        .filter((r) => r.effective_from > asOf)
        .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0] ?? null
    );
  }
}

/** Every live master row, all history included. `tx` defaults to the database. */
export async function loadHsnRows(d: Database, tx: any = d.db): Promise<HsnRow[]> {
  const t = d.schema.hsn_master;
  const rows: AnyRow[] = await tx
    .select({
      code: t.code,
      description: t.description,
      rate_bp: t.rate_bp,
      cess_bp: t.cess_bp,
      effective_from: t.effective_from,
      effective_to: t.effective_to,
    })
    .from(t)
    .where(sql`${t.deleted_at} IS NULL`);
  return rows.map(toHsnRow);
}

export async function loadHsnResolver(d: Database, tx: any = d.db): Promise<HsnResolver> {
  return new HsnResolver(await loadHsnRows(d, tx));
}

export interface HsnLookupResult {
  code: string;
  description: string;
  rate_bp: number;
  cess_bp: number;
}

/** The master entry for a code on a date (today when omitted). Pass `tx` to read inside a transaction. */
export async function lookupHsn(
  d: Database,
  code: string,
  asOf = new Date().toISOString().slice(0, 10),
  tx: any = d.db,
): Promise<HsnLookupResult | null> {
  const t = d.schema.hsn_master;
  const prefixes = [...new Set([code, code.slice(0, 6), code.slice(0, 4)])].filter(
    (c) => c.length >= 4 && c.length <= code.length,
  );
  for (const p of prefixes) {
    const rows: AnyRow[] = await tx
      .select({
        code: t.code,
        description: t.description,
        rate_bp: t.rate_bp,
        cess_bp: t.cess_bp,
        effective_from: t.effective_from,
        effective_to: t.effective_to,
      })
      .from(t)
      .where(and(eq(t.code, p), sql`${t.deleted_at} IS NULL`));
    const hit = rowAsOf(rows.map(toHsnRow), asOf);
    if (hit) {
      return {
        code: hit.code,
        description: hit.description,
        rate_bp: hit.rate_bp,
        cess_bp: hit.cess_bp,
      };
    }
  }
  return null;
}

export interface HsnVersionMeta {
  version: string;
  /** Date the rates were checked against. */
  as_of: string;
  source?: string;
  notes?: string;
  sha256?: string;
}

export interface HsnImportResult {
  /** True when this version was already imported; nothing changed. */
  skipped: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  rateChanges: HsnRateChange[];
}

/**
 * Import a version of the master in one transaction. Rate history is kept: a changed rate closes the
 * previous row the day before and adds a new one, so a document issued under the old rate stays
 * explainable. Importing the same version twice does nothing.
 */
export async function importHsnVersion(
  d: Database,
  meta: HsnVersionMeta,
  rows: readonly HsnRow[],
): Promise<HsnImportResult> {
  const s = d.schema;
  let owned: any;
  const result = await d.db.transaction(async (tx: any): Promise<HsnImportResult> => {
    owned = tx;
    const known: AnyRow[] = await tx
      .select({ id: s.rate_master_versions.id })
      .from(s.rate_master_versions)
      .where(eq(s.rate_master_versions.version, meta.version));
    if (known.length > 0)
      return { skipped: true, inserted: 0, updated: 0, unchanged: 0, rateChanges: [] };

    const plan = planHsnImport(await loadHsnRows(d, tx), rows);
    const now = Date.now();
    const toInsert = plan.inserts.map((r) => ({
      id: newId(),
      created_at: now,
      updated_at: now,
      code: r.code,
      description: r.description,
      rate_bp: r.rate_bp,
      cess_bp: r.cess_bp,
      effective_from: r.effective_from,
      effective_to: r.effective_to ?? null,
      source_version: meta.version,
    }));
    for (let i = 0; i < toInsert.length; i += 200) {
      await tx.insert(s.hsn_master).values(toInsert.slice(i, i + 200));
    }
    for (const u of plan.updates) {
      await tx
        .update(s.hsn_master)
        .set({ ...u.patch, updated_at: now, source_version: meta.version })
        .where(
          and(eq(s.hsn_master.code, u.code), eq(s.hsn_master.effective_from, u.effective_from)),
        );
    }
    const earliest = rows.reduce(
      (m, r) => (r.effective_from < m ? r.effective_from : m),
      meta.as_of,
    );
    await tx.insert(s.rate_master_versions).values({
      id: newId(),
      created_at: now,
      updated_at: now,
      version: meta.version,
      effective_from: earliest,
      as_of: meta.as_of,
      source: meta.source ?? null,
      notes: meta.notes ?? null,
      sha256: meta.sha256 ?? null,
      row_count: rows.length,
      published_at: now,
      imported_at: now,
    });
    noteWrite(tx, 'hsn_master');
    noteWrite(tx, 'rate_master_versions');
    return {
      skipped: false,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
      rateChanges: plan.rateChanges,
    };
  });
  if (owned) flushWrites(d, owned);
  return result;
}

export interface HsnVersionRow {
  version: string;
  as_of: string | null;
  row_count: number | null;
  imported_at: number | null;
  source: string | null;
}

/** Imported versions, newest first. */
export async function listHsnVersions(d: Database): Promise<HsnVersionRow[]> {
  const rows: AnyRow[] = await d.db.select().from(d.schema.rate_master_versions);
  return rows
    .map((r) => ({
      version: String(r['version']),
      as_of: r['as_of'] ? String(r['as_of']) : null,
      row_count:
        r['row_count'] === null || r['row_count'] === undefined ? null : Number(r['row_count']),
      imported_at:
        r['imported_at'] === null || r['imported_at'] === undefined
          ? null
          : Number(r['imported_at']),
      source: r['source'] ? String(r['source']) : null,
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}
