/**
 * Tier 2 in the app (prompt 48). `GatewayProvider` is the router's cloud backend when the business is on the
 * cloud plan: it sends what the device read to our gateway, which keeps the quota, the redaction and the
 * metering, and hands back a value checked against the schema. With a person's own key on the desktop the
 * router gets the Anthropic provider itself instead (`byokProvider`), with the same masking and review rules.
 * Either way the router calls Tier 2 only when the request says `allowCloud: true`.
 */
import {
  AnthropicProvider,
  BaseProvider,
  fail,
  mismatchExplanationSchema,
  purchaseBillSchema,
  validated,
  type AiDocument,
  type AiPrompt,
  type AiResult,
  type Capability,
  type ExtractOpts,
  type Schema,
} from '@gst/ai';

import type { CloudClient } from '../cloud/client';
import { CloudError } from '../cloud/client';
import { isDesktop, secretGet } from '../desktop/bridge';

export const BYOK_SECRET = 'anthropic_api_key';

export interface GatewayTarget {
  client: CloudClient;
  orgId: string;
  businessId: string;
}

const toError = (e: unknown): AiResult<never> => {
  if (e instanceof CloudError) {
    if (e.code === 'ai_quota' || e.code === 'ai_plan') return fail('quota', e.message);
    if (e.code === 'ai_refused') return fail('refused', e.message);
    if (e.code === 'ai_invalid') return fail('invalid_output', e.message);
    return fail('unavailable', e.message, e.status >= 500);
  }
  return fail('unavailable', e instanceof Error ? e.message : String(e), true);
};

/** The cloud gateway as a router backend: bills and the mismatch explainer go through it. */
export class GatewayProvider extends BaseProvider {
  readonly id = 'anthropic' as const;
  /** The last answer's quota, for the screens to warn at 80%. */
  quota: { used: number; limit: number; warning: boolean } | null = null;

  constructor(private readonly g: GatewayTarget) {
    super();
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['extract', 'suggest']);
  }

  override async extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts: ExtractOpts = {},
  ): Promise<AiResult<T>> {
    if ((opts.schemaName ?? opts.feature) !== 'purchaseBill' && opts.feature !== 'bill_extract')
      return fail('unsupported', 'the gateway reads purchase bills only');
    if (!doc.text?.trim()) return fail('unsupported', 'the gateway needs the text the device read');
    const started = performance.now();
    try {
      const r = await this.g.client.aiExtractBill(this.g.orgId, {
        businessId: this.g.businessId,
        text: doc.text,
      });
      this.quota = r.quota;
      return validated(schema, r.bill, {
        provider: this.id,
        model: r.model,
        confidence: 0.9,
        fieldConfidence: r.fieldConfidence,
        usage: r.usage,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      return toError(e);
    }
  }

  override async suggest<T>(prompt: AiPrompt, schema: Schema<T>): Promise<AiResult<T>> {
    if (prompt.feature !== 'explain_2b_mismatch')
      return fail('unsupported', `the gateway has no route for ${prompt.feature}`);
    const started = performance.now();
    try {
      const r = await this.g.client.aiExplainMismatch(this.g.orgId, {
        businessId: this.g.businessId,
        row: prompt.input,
      });
      this.quota = r.quota;
      const parsed = mismatchExplanationSchema.parse(r);
      return validated(schema, parsed, {
        provider: this.id,
        model: r.model,
        confidence: parsed.confidence,
        usage: r.usage,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      return toError(e);
    }
  }
}

/** The person's own key, from the desktop's keychain; null off the desktop or when none is saved. */
export async function byokProvider(context?: {
  profile?: string;
  hsnExcerpt?: string;
}): Promise<AnthropicProvider | null> {
  if (!isDesktop()) return null;
  const key = await secretGet(BYOK_SECRET).catch(() => null);
  if (!key) return null;
  return new AnthropicProvider({
    apiKey: key,
    dangerouslyAllowBrowser: true,
    ...(context ? { context } : {}),
  });
}

export { purchaseBillSchema };
