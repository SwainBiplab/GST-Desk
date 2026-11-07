/**
 * The Tier 0 pieces of prompt 36 as rules and an extractor, so the router can serve a bill, a spoken
 * sentence or an HSN query with no model at all, and a model only ever improves on them.
 */
import type { RulesProvider } from '../rules/provider';

import { extractBillFromText } from './extract/rules';
import { parseSpeech } from './voice/parse';

/** Register the bill extractor and the speech parser on a rules provider. */
export function withTier0Local(
  rules: RulesProvider,
  opts: { ownGstin?: () => string | null; rateForHsn?: (hsn: string) => number | null } = {},
): RulesProvider {
  rules.registerExtractor('purchaseBill', async (doc) => {
    if (!doc.text) throw new Error('needs text: run OCR first');
    const r = extractBillFromText(doc.text, {
      ownGstin: opts.ownGstin?.() ?? null,
      ...(opts.rateForHsn ? { rateForHsn: opts.rateForHsn } : {}),
    });
    const fields = Object.values(r.fieldConfidence);
    return {
      value: r.bill,
      confidence: fields.length ? fields.reduce((a, b) => a + b, 0) / fields.length : 0.2,
      fieldConfidence: r.fieldConfidence,
    };
  });
  rules.registerRule('voice_draft', async (input) => {
    const { confidence, ...value } = parseSpeech(String((input as { text?: unknown })?.text ?? ''));
    return { value, confidence };
  });
  rules.registerRule('paraphrase', async (input, _env) => {
    // rules cannot rephrase: hand back the text unchanged with low confidence so a model is preferred
    const text = String((input as { text?: unknown })?.text ?? '');
    return { value: { text }, confidence: 0.1 };
  });
  return rules;
}
