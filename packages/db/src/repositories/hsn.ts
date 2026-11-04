import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';

import { newId, searchTokens } from './base';

export interface HsnEntry {
  code: string;
  description: string;
  rate_bp: number;
  cess_bp?: number;
  effective_from: string;
  effective_to?: string | null;
  source_version?: string | null;
}

export interface HsnHit {
  code: string;
  description: string;
  rate_bp: number;
  cess_bp: number;
  /** Higher is better. BM25 on SQLite, ts_rank_cd on Postgres. */
  score: number;
}

/** Load reference rows (also used by tests and the demo seed). */
export async function insertHsnEntries(d: Database, entries: HsnEntry[]): Promise<void> {
  const now = Date.now();
  const rows = entries.map((e) => ({
    id: newId(),
    created_at: now,
    updated_at: now,
    cess_bp: 0,
    effective_to: null,
    source_version: null,
    ...e,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await d.db.insert(d.schema.hsn_master).values(rows.slice(i, i + 100));
  }
}

/**
 * Relevance-ranked HSN/SAC lookup over descriptions (FTS5 BM25 on SQLite, tsvector on Postgres).
 * Any word may match; rows matching more, rarer words rank higher. `asOf` filters by effective dates.
 */
export async function searchHsn(
  d: Database,
  text: string,
  opts: { limit?: number; asOf?: string } = {},
): Promise<HsnHit[]> {
  const tokens = searchTokens(text);
  if (tokens.length === 0) return [];
  const limit = Math.trunc(opts.limit ?? 5);
  const asOf = opts.asOf ?? '9999-12-31';
  if (d.dialect === 'sqlite') {
    const match = tokens.map((t) => `"${t}"`).join(' OR ');
    const rows = await queryRows(
      d,
      d.db,
      sql`SELECT h.code, h.description, h.rate_bp, h.cess_bp, -bm25(hsn_master_fts) AS score
          FROM hsn_master_fts
          JOIN hsn_master h ON h.id = hsn_master_fts.id
          WHERE hsn_master_fts MATCH ${match}
            AND h.deleted_at IS NULL
            AND h.effective_from <= ${asOf}
            AND (h.effective_to IS NULL OR h.effective_to >= ${asOf})
          ORDER BY bm25(hsn_master_fts)
          LIMIT ${limit}`,
    );
    return rows.map(toHit);
  }
  const tsq = tokens.map((t) => `${t}:*`).join(' | ');
  const rows = await queryRows(
    d,
    d.db,
    sql`SELECT code, description, rate_bp, cess_bp, ts_rank_cd(search, q) AS score
        FROM hsn_master, to_tsquery('english', ${tsq}) AS q
        WHERE search @@ q
          AND deleted_at IS NULL
          AND effective_from <= ${asOf}::date
          AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
        ORDER BY score DESC
        LIMIT ${limit}`,
  );
  return rows.map(toHit);
}

function toHit(r: Record<string, any>): HsnHit {
  return {
    code: String(r['code']),
    description: String(r['description']),
    rate_bp: Number(r['rate_bp']),
    cess_bp: Number(r['cess_bp']),
    score: Number(r['score']),
  };
}
