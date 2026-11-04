import {
  AiRouter,
  RulesProvider,
  hsnSuggestionsSchema,
  type HsnSuggestion,
  type RulesEnv,
} from '@gst/ai';
import { DbHsnLookup } from '@gst/ai/db';
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
