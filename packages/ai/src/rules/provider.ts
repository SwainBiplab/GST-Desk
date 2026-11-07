import {
  BaseProvider,
  fail,
  validated,
  type AiDocument,
  type AiPrompt,
  type AiResult,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type Schema,
} from '../provider';

import { findDuplicateParties, type PartyLite } from './duplicates';
import type { HsnLookup } from './hsn';

/** What rules can read. Both are optional; a rule that needs a missing source reports `rule_failed`. */
export interface RulesEnv {
  hsn?: HsnLookup;
  parties?: () => Promise<PartyLite[]>;
}

export interface RuleOutcome {
  value: unknown;
  /** 0..1 */
  confidence: number;
  fieldConfidence?: Record<string, number>;
}

/** A rule turns a feature's input into a proposal. Register more with `registerRule`. */
export type Rule = (input: any, env: RulesEnv) => Promise<RuleOutcome>;

export const hsnLookupRule: Rule = async (input, env) => {
  if (!env.hsn) throw new Error('no HSN source configured');
  const description = String(input?.description ?? '');
  const hits = await env.hsn.search(description, Number(input?.limit ?? 3));
  const s1 = hits[0]?.score ?? 0;
  const s2 = hits[1]?.score ?? 0;
  const margin = s1 > 0 ? (s1 - s2) / s1 : 0;
  return {
    value: { suggestions: hits },
    confidence: hits.length ? Math.min(0.95, 0.4 + 0.5 * margin) : 0.2,
  };
};

/** An extractor turns a document (text, after OCR) into a proposal, the way a rule turns an input into one. */
export type Extractor = (doc: AiDocument, env: RulesEnv) => Promise<RuleOutcome>;

export const duplicatePartyRule: Rule = async (input, env) => {
  if (!env.parties) throw new Error('no party source configured');
  const matches = findDuplicateParties(
    { name: String(input?.name ?? ''), gstin: input?.gstin ?? null, phone: input?.phone ?? null },
    await env.parties(),
  );
  const strong = matches.some((m) => m.reasons.includes('gstin'));
  return { value: { matches }, confidence: strong ? 0.98 : matches.length ? 0.75 : 0.9 };
};

/** Tier 0: deterministic rules, no model, works offline. */
export class RulesProvider extends BaseProvider {
  readonly id = 'rules' as const;
  private readonly rules = new Map<string, Rule>([
    ['hsn_lookup', hsnLookupRule],
    ['duplicate_party', duplicatePartyRule],
  ]);

  private readonly extractors = new Map<string, Extractor>();

  constructor(private readonly env: RulesEnv = {}) {
    super();
  }

  capabilities(): Set<Capability> {
    const c = new Set<Capability>(['suggest']);
    if (this.extractors.size) c.add('extract');
    return c;
  }

  /** Add a Tier 0 extractor for a schema name (`purchaseBill`). */
  registerExtractor(schemaName: string, fn: Extractor): this {
    this.extractors.set(schemaName, fn);
    return this;
  }

  override async extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts: ExtractOpts = {},
  ): Promise<AiResult<T>> {
    const name = opts.schemaName ?? opts.feature ?? '';
    const fn = this.extractors.get(name);
    if (!fn) return fail('unsupported', `no extractor registered for "${name}"`, true);
    const started = performance.now();
    try {
      const out = await fn(doc, this.env);
      return validated(schema, out.value, {
        provider: this.id,
        model: `rules:${name}`,
        confidence: out.confidence,
        ...(out.fieldConfidence ? { fieldConfidence: out.fieldConfidence } : {}),
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      return fail('rule_failed', e instanceof Error ? e.message : String(e), true);
    }
  }

  /** Hook for later prompts: add or replace the rule behind a feature id. */
  registerRule(feature: string, rule: Rule): this {
    this.rules.set(feature, rule);
    return this;
  }

  hasRule(feature: string): boolean {
    return this.rules.has(feature);
  }

  override async suggest<T>(
    prompt: AiPrompt,
    schema: Schema<T>,
    _opts?: CallOpts,
  ): Promise<AiResult<T>> {
    const rule = this.rules.get(prompt.feature);
    if (!rule) return fail('unsupported', `no rule registered for "${prompt.feature}"`, true);
    const started = performance.now();
    try {
      const out = await rule(prompt.input, this.env);
      return validated(schema, out.value, {
        provider: this.id,
        model: `rules:${prompt.feature}`,
        confidence: out.confidence,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      return fail('rule_failed', e instanceof Error ? e.message : String(e), true);
    }
  }
}
