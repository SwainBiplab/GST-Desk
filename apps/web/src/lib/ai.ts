import { AiRouter, InMemoryHsnLookup, RulesProvider, hsnSuggestionsSchema } from '@gst/ai';
import hsnMaster from '@gst/ai/fixtures/hsn-master.json';

/**
 * Offline router: Tier 0 rules only. Tiers 1 and 2 are switched on by settings in later prompts.
 * The bundled HSN sample stands in for `hsn_master` until the real master is loaded (prompt 13).
 */
export const aiRouter = new AiRouter({
  settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
  providers: [new RulesProvider({ hsn: new InMemoryHsnLookup(hsnMaster) })],
});

export async function suggestHsn(description: string, limit = 3) {
  const r = await aiRouter.suggest(
    { feature: 'hsn_lookup', input: { description, limit } },
    hsnSuggestionsSchema,
  );
  return r.ok ? r.value.suggestions : [];
}
