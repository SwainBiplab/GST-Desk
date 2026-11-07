import {
  AiRouter,
  HashEmbedder,
  RulesProvider,
  hsnSuggestionsSchema,
  type HsnLookup,
  type HsnSuggestion,
  type RulesEnv,
} from '@gst/ai';
import { DbHsnLookup, hybridHsnLookupFor } from '@gst/ai/db';
import type { Database } from '@gst/db';

/** Offline router: Tier 0 rules only. Tiers 1 and 2 are switched on by settings in later prompts. */
export function aiRouterFor(env: RulesEnv = {}): AiRouter {
  return new AiRouter({
    settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
    providers: [new RulesProvider(env)],
  });
}

export const aiRouter = aiRouterFor();

/** Router whose HSN rule searches this device's `hsn_master` (full-text, offline). */
export function hsnRouterFor(database: Database): AiRouter {
  return aiRouterFor({ hsn: new DbHsnLookup(database) });
}

/**
 * The lookup grows semantic once the index has been built (Settings, AI): BM25 merged with vectors.
 * Until then it is plain full-text, so nothing changes for a book that never opened that page.
 */
let hybrid: { db: Database; lookup: Promise<HsnLookup> } | null = null;
export function hybridHsnRouterFor(database: Database): Promise<AiRouter> {
  if (!hybrid || hybrid.db !== database)
    hybrid = { db: database, lookup: hybridHsnLookupFor(database, new HashEmbedder(256)) };
  return hybrid.lookup.then((hsn) => aiRouterFor({ hsn }));
}
/** Forget the cached lookup after the index is rebuilt. */
export const resetHybridHsn = () => {
  hybrid = null;
};

/** Top matches for a description of an item, each with its rate. */
export async function suggestHsn(
  router: AiRouter,
  description: string,
  limit = 3,
): Promise<HsnSuggestion[]> {
  const r = await router.suggest(
    { feature: 'hsn_lookup', input: { description, limit } },
    hsnSuggestionsSchema,
  );
  return r.ok ? r.value.suggestions : [];
}
