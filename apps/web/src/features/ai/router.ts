/**
 * The router the app uses, built from the settings: rules (always, with the hybrid HSN lookup when
 * vectors exist), then the chosen Tier 1 backend. Rebuilt when settings or downloaded models change.
 */
import {
  AiRouter,
  HashEmbedder,
  LocalLlamaProvider,
  OllamaProvider,
  RulesProvider,
  WebLlmProvider,
  withTier0Local,
  type AiProvider,
  type Embedder,
  type HsnLookup,
  type RouterSettings,
} from '@gst/ai';
import { DbCallLogger, createDbRulesEnv, hybridHsnLookupFor } from '@gst/ai/db';
import type { Ctx, Database, Row } from '@gst/db';
import { useEffect, useState } from 'react';

import { isDesktop } from '../desktop/bridge';
import { useMessaging } from '../dispatch/use-messaging';

import { GatewayProvider, byokProvider, type GatewayTarget } from './cloud';
import { detectHardware, modelManager, useModelStates } from './models';
import { keeperFor } from './runtime';
import { useAiSettings, type AiSettings } from './settings';

/** The embedder behind HSN vectors: the local embedding model when it is downloaded, else the hashed trigrams. */
export function embedderFor(settings: AiSettings): Embedder {
  const m = modelManager();
  const e = settings.embedModelId ? m.entry(settings.embedModelId) : null;
  if (isDesktop() && e && m.get(e.id)?.status === 'ready' && settings.tier1 === 'builtin') {
    const provider = new LocalLlamaProvider({
      embedder: keeperFor('llama', e.file),
      modelName: e.id,
    });
    return { model: e.id, dims: 0, embed: (texts) => provider.embed(texts) };
  }
  return new HashEmbedder(256);
}

export interface BuiltRouter {
  router: AiRouter;
  tier1: AiProvider | null;
  /** The cloud backend (prompt 48), when the business opted in and one is reachable. */
  tier2: AiProvider | null;
  hsn: HsnLookup;
}

/** The Tier 2 backend for the settings: our gateway for a cloud business, or the person's own key on the desktop. */
export async function cloudProvider(
  settings: AiSettings,
  business: Row | null,
  gateway: GatewayTarget | null,
): Promise<AiProvider | null> {
  if (!settings.cloud.enabled) return null;
  if (settings.cloud.mode === 'byok')
    return byokProvider(
      business
        ? {
            profile: `${String(business['trade_name'] || business['legal_name'] || '')}${business['gstin'] ? `, GSTIN ${business['gstin']}` : ''}, state code ${business['state_code']}, ${business['scheme'] ?? 'regular'} scheme.`,
          }
        : undefined,
    );
  return gateway ? new GatewayProvider(gateway) : null;
}

export async function buildRouter(
  db: Database,
  ctx: Ctx,
  business: Row | null,
  settings: AiSettings,
  gateway: GatewayTarget | null = null,
): Promise<BuiltRouter> {
  const hsn = await hybridHsnLookupFor(db, embedderFor(settings));
  const env = { ...createDbRulesEnv(db, ctx), hsn };
  const rules = withTier0Local(new RulesProvider(env), {
    ownGstin: () => (business?.['gstin'] as string | null) ?? null,
  });
  const m = modelManager();
  let tier1: AiProvider | null = null;
  let tier1Id: RouterSettings['tier1'] = null;
  if (settings.tier1 === 'builtin' && isDesktop()) {
    const llm =
      settings.llmModelId && m.get(settings.llmModelId)?.status === 'ready'
        ? m.entry(settings.llmModelId)
        : null;
    const whisper =
      settings.whisperModelId && m.get(settings.whisperModelId)?.status === 'ready'
        ? m.entry(settings.whisperModelId)
        : null;
    const embed =
      settings.embedModelId && m.get(settings.embedModelId)?.status === 'ready'
        ? m.entry(settings.embedModelId)
        : null;
    if (llm || whisper) {
      tier1 = new LocalLlamaProvider({
        ...(llm ? { llm: keeperFor('llama', llm.file) } : {}),
        ...(embed ? { embedder: keeperFor('llama', embed.file), embedModelName: embed.id } : {}),
        ...(whisper
          ? { whisper: keeperFor('whisper', whisper.file), whisperModelName: whisper.id }
          : {}),
        modelName: llm?.id ?? 'none',
      });
      tier1Id = 'local-llama';
    }
  } else if (settings.tier1 === 'ollama') {
    tier1 = new OllamaProvider({ baseUrl: settings.ollamaUrl, model: settings.ollamaModel });
    tier1Id = 'ollama';
  } else if (settings.tier1 === 'webllm' && 'gpu' in navigator) {
    try {
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
      const engine = await CreateMLCEngine(
        settings.llmModelId ?? 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      );
      tier1 = new WebLlmProvider(
        engine as never,
        settings.llmModelId ?? 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      );
      tier1Id = 'webllm';
    } catch {
      tier1 = null;
    }
  }
  const hw = await detectHardware();
  const tier2 = await cloudProvider(settings, business, gateway);
  const router = new AiRouter({
    settings: {
      tier0: true,
      tier1: tier1Id,
      tier2: tier2 ? 'anthropic' : null,
      askBeforeCloud: settings.cloud.askEachTime,
    },
    providers: [rules, ...(tier1 ? [tier1] : []), ...(tier2 ? [tier2] : [])],
    hardware: { ramGb: hw.ramGb, cores: hw.cores, gpu: hw.gpu !== 'none' && hw.gpu !== 'unknown' },
    logger: new DbCallLogger(db, ctx),
  });
  return { router, tier1, tier2, hsn };
}

/** The app's router for the current business and settings; null until built. */
export function useAiRouter(
  db: Database | null,
  ctx: Ctx | null,
  business: Row | null,
): BuiltRouter | null {
  const settings = useAiSettings();
  const states = useModelStates();
  const cloud = useMessaging();
  const gateway: GatewayTarget | null =
    cloud.kind === 'ready'
      ? { client: cloud.m.client, orgId: cloud.m.orgId, businessId: cloud.m.businessId }
      : null;
  const [built, setBuilt] = useState<BuiltRouter | null>(null);
  const s = settings.data;
  const key = s ? JSON.stringify(s) : '';
  const gatewayKey = gateway ? `${gateway.orgId}:${gateway.businessId}` : '';
  useEffect(() => {
    if (!db || !ctx || !s) return;
    let live = true;
    void buildRouter(db, ctx, business, s, gateway).then((b) => live && setBuilt(b));
    return () => {
      live = false;
    };
    // the settings are compared by value; the model states string changes when a download finishes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, ctx?.businessId, key, states, gatewayKey]);
  return built;
}
