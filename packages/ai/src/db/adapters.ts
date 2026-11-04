import { PartyRepo, newId, runInTx, searchHsn, type Ctx, type Database } from '@gst/db';

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
