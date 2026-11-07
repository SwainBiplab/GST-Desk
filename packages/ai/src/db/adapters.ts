import { PartyRepo, newId, queryRows, runInTx, searchHsn, type Ctx, type Database } from '@gst/db';
import { sql } from 'drizzle-orm';

import {
  HsnVectorIndex,
  HybridHsnLookup,
  buildHsnVectors,
  type Embedder,
  type HsnVector,
} from '../local/embed';
import type { AiCallLogger, CallLogEntry } from '../router';
import type { PartyLite } from '../rules/duplicates';
import type { HsnLookup, HsnSuggestion } from '../rules/hsn';
import type { RulesEnv } from '../rules/provider';

/** HSN lookup over `hsn_master` (FTS5 BM25 on SQLite, tsvector on Postgres). */
export class DbHsnLookup implements HsnLookup {
  constructor(
    private readonly db: Database,
    private readonly asOf?: string,
  ) {}

  async search(text: string, limit: number): Promise<HsnSuggestion[]> {
    const hits = await searchHsn(this.db, text, {
      limit,
      ...(this.asOf ? { asOf: this.asOf } : {}),
    });
    return hits.map((h) => ({
      code: h.code,
      description: h.description,
      rateBp: h.rate_bp,
      cessBp: h.cess_bp,
      score: h.score,
    }));
  }
}

/** Rules environment backed by the local database. */
export function createDbRulesEnv(db: Database, ctx: Ctx): RulesEnv {
  return {
    hsn: new DbHsnLookup(db),
    parties: async (): Promise<PartyLite[]> =>
      (await new PartyRepo(db).list(ctx)).map((p) => ({
        id: p['id'],
        name: p['name'],
        gstin: p['gstin'],
        phone: p['phone'],
      })),
  };
}

/** The vectors stored for one embedding model, or an empty list before `indexHsnMaster` has run. */
export async function loadHsnVectors(db: Database, model: string): Promise<HsnVector[]> {
  const rows = await queryRows(
    db,
    db.db,
    sql`SELECT e.code, e.vector_json, h.description, h.rate_bp, h.cess_bp
        FROM hsn_embeddings e
        JOIN hsn_master h ON h.code = e.code AND h.deleted_at IS NULL AND h.effective_to IS NULL
        WHERE e.model = ${model} AND e.deleted_at IS NULL`,
  );
  return rows.map((r) => {
    const raw =
      typeof r['vector_json'] === 'string'
        ? (JSON.parse(r['vector_json']) as number[])
        : (r['vector_json'] as number[]);
    return {
      code: String(r['code']),
      description: String(r['description']),
      rateBp: Number(r['rate_bp']),
      cessBp: Number(r['cess_bp'] ?? 0),
      vector: Float32Array.from(raw),
    };
  });
}

/** Embed every current HSN row with `embedder` and store the vectors (one row per code and model, replaced on a rerun). */
export async function indexHsnMaster(
  db: Database,
  ctx: Ctx,
  embedder: Embedder,
  opts: { batch?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const rows = await queryRows(
    db,
    db.db,
    sql`SELECT code, description, rate_bp, cess_bp FROM hsn_master WHERE deleted_at IS NULL AND effective_to IS NULL ORDER BY code`,
  );
  const entries = rows.map((r) => ({
    code: String(r['code']),
    description: String(r['description']),
    rate_bp: Number(r['rate_bp']),
    cess_bp: Number(r['cess_bp'] ?? 0),
  }));
  const batch = opts.batch ?? 64;
  let done = 0;
  for (let i = 0; i < entries.length; i += batch) {
    const slice = entries.slice(i, i + batch);
    const vectors = await buildHsnVectors(slice, embedder, batch);
    await runInTx(db, ctx, async (tx) => {
      const t = db.schema.hsn_embeddings;
      const now = Date.now();
      for (const v of vectors) {
        await tx
          .insert(t)
          .values({
            id: newId(),
            created_at: now,
            updated_at: now,
            code: v.code,
            model: embedder.model,
            dims: embedder.dims,
            vector_json: [...v.vector],
          })
          .onConflictDoUpdate({
            target: [t.code, t.model],
            set: { dims: embedder.dims, vector_json: [...v.vector], updated_at: now },
          });
      }
    });
    done += slice.length;
    opts.onProgress?.(done, entries.length);
  }
  return done;
}

/** BM25 over `hsn_master` merged with the stored vectors; plain BM25 until vectors exist for the model. */
export async function hybridHsnLookupFor(
  db: Database,
  embedder: Embedder,
): Promise<DbHsnLookup | HybridHsnLookup> {
  const lexical = new DbHsnLookup(db);
  const vectors = await loadHsnVectors(db, embedder.model);
  return vectors.length
    ? new HybridHsnLookup(lexical, new HsnVectorIndex(vectors), embedder)
    : lexical;
}

/** Writes one `ai_calls` row per provider attempt: feature, provider, model, tokens, latency, outcome. */
export class DbCallLogger implements AiCallLogger {
  constructor(
    private readonly db: Database,
    private readonly ctx: Ctx,
  ) {}

  async log(e: CallLogEntry): Promise<void> {
    await runInTx(this.db, this.ctx, (tx) =>
      tx.insert(this.db.schema.ai_calls).values({
        id: newId(),
        org_id: this.ctx.orgId,
        business_id: this.ctx.businessId,
        created_at: Date.now(),
        feature: e.feature,
        capability: e.capability,
        provider: e.provider,
        model: e.model ?? null,
        input_tokens: e.inputTokens ?? null,
        output_tokens: e.outputTokens ?? null,
        latency_ms: e.latencyMs,
        outcome: e.outcome,
      }),
    );
  }
}
