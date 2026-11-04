import {
  fail,
  type AiAudio,
  type AiChatEvent,
  type AiDocument,
  type AiError,
  type AiMessage,
  type AiProvider,
  type AiPrompt,
  type AiResult,
  type AiTool,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type ProviderId,
  type Schema,
} from './provider';

export interface RouterSettings {
  /** Deterministic rules, always offline. */
  tier0: boolean;
  /** Local model backend, if any. */
  tier1: 'local-llama' | 'ollama' | 'webllm' | null;
  /** Cloud backend, if any. Only used when a request sets `allowCloud: true`. */
  tier2: 'anthropic' | null;
  /** UI hint: ask the user before setting `allowCloud`. The router never sends to Tier 2 without it. */
  askBeforeCloud: boolean;
}

export interface HardwareProfile {
  ramGb: number;
  cores: number;
  gpu?: boolean;
}

/** One line per provider attempt. Metadata only: never prompts or responses. */
export interface CallLogEntry {
  feature: string;
  capability: Capability;
  provider: ProviderId;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  outcome: 'ok' | AiError['code'] | 'error';
}

export interface AiCallLogger {
  log(entry: CallLogEntry): void | Promise<void>;
}

export interface RouterOptions {
  settings: RouterSettings;
  providers: AiProvider[];
  hardware?: HardwareProfile;
  logger?: AiCallLogger;
}

/** Minimum hardware per backend; a backend that does not fit is skipped, not failed. */
function fitsHardware(id: ProviderId, hw: HardwareProfile | undefined): boolean {
  if (!hw) return true;
  if (id === 'local-llama') return hw.ramGb >= 8 && hw.cores >= 4;
  if (id === 'webllm') return hw.gpu === true;
  return true;
}

export class AiRouter {
  private readonly byId = new Map<ProviderId, AiProvider>();

  constructor(private readonly opts: RouterOptions) {
    for (const p of opts.providers) this.byId.set(p.id, p);
  }

  /**
   * Providers to try, best first: mock (tests), Tier 2 (only with `allowCloud`), Tier 1, Tier 0.
   * Providers that lack the capability or do not fit the hardware are left out.
   */
  plan(capability: Capability, allowCloud = false): AiProvider[] {
    const { settings, hardware } = this.opts;
    const ids: ProviderId[] = [];
    if (this.byId.has('mock')) ids.push('mock');
    if (settings.tier2 && allowCloud === true) ids.push(settings.tier2);
    if (settings.tier1 && fitsHardware(settings.tier1, hardware)) ids.push(settings.tier1);
    if (settings.tier0) ids.push('rules');
    return ids
      .map((id) => this.byId.get(id))
      .filter((p): p is AiProvider => !!p && p.capabilities().has(capability));
  }

  /** True when a cloud backend is configured and could be used if the caller consents. */
  cloudAvailable(capability: Capability): boolean {
    const id = this.opts.settings.tier2;
    const p = id ? this.byId.get(id) : undefined;
    return !!p && p.capabilities().has(capability);
  }

  private async log(entry: CallLogEntry): Promise<void> {
    try {
      await this.opts.logger?.log(entry);
    } catch {
      /* logging must never break a feature */
    }
  }

  private async attempt<T>(
    p: AiProvider,
    capability: Capability,
    feature: string,
    run: () => Promise<AiResult<T>>,
  ): Promise<AiResult<T>> {
    const started = performance.now();
    let result: AiResult<T>;
    try {
      result = await run();
    } catch (e) {
      result = fail('unavailable', e instanceof Error ? e.message : String(e), true);
    }
    const latencyMs = Math.round(performance.now() - started);
    await this.log({
      feature,
      capability,
      provider: p.id,
      ...(result.ok
        ? {
            model: result.model,
            ...(result.usage?.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage?.outputTokens !== undefined
              ? { outputTokens: result.usage.outputTokens }
              : {}),
            latencyMs: result.latencyMs || latencyMs,
            outcome: 'ok' as const,
          }
        : { latencyMs, outcome: result.error.code }),
    });
    return result;
  }

  private async firstOk<T>(
    capability: Capability,
    feature: string,
    allowCloud: boolean | undefined,
    signal: AbortSignal | undefined,
    run: (p: AiProvider) => Promise<AiResult<T>>,
  ): Promise<AiResult<T>> {
    const chain = this.plan(capability, allowCloud === true);
    let last: AiResult<T> | undefined;
    for (const p of chain) {
      if (signal?.aborted) return fail('cancelled', 'request cancelled');
      const r = await this.attempt(p, capability, feature, () => run(p));
      if (r.ok) return r;
      // keep the most informative failure: prefer one that is not just "unsupported"
      if (!last || last.ok || last.error.code === 'unsupported' || r.error.code !== 'unsupported')
        last = r;
    }
    return last ?? fail('no_provider', `no provider available for ${capability}`);
  }

  extract<T>(doc: AiDocument, schema: Schema<T>, opts: ExtractOpts = {}): Promise<AiResult<T>> {
    return this.firstOk('extract', opts.feature ?? 'extract', opts.allowCloud, opts.signal, (p) =>
      p.extract(doc, schema, opts),
    );
  }

  suggest<T>(prompt: AiPrompt, schema: Schema<T>, opts: CallOpts = {}): Promise<AiResult<T>> {
    return this.firstOk('suggest', prompt.feature, opts.allowCloud, opts.signal, (p) =>
      p.suggest(prompt, schema, opts),
    );
  }

  transcribe(
    audio: AiAudio,
    opts: CallOpts & { language?: string } = {},
  ): Promise<AiResult<{ text: string }>> {
    return this.firstOk(
      'transcribe',
      opts.feature ?? 'transcribe',
      opts.allowCloud,
      opts.signal,
      (p) => p.transcribe(audio, opts.language ? { language: opts.language } : {}),
    );
  }

  /** Embeddings throw (there is no result envelope); the first working provider wins. */
  async embed(texts: string[], opts: CallOpts = {}): Promise<Float32Array[]> {
    let lastError: unknown;
    for (const p of this.plan('embed', opts.allowCloud === true)) {
      const started = performance.now();
      try {
        const out = await p.embed(texts);
        await this.log({
          feature: opts.feature ?? 'embed',
          capability: 'embed',
          provider: p.id,
          latencyMs: Math.round(performance.now() - started),
          outcome: 'ok',
        });
        return out;
      } catch (e) {
        lastError = e;
        await this.log({
          feature: opts.feature ?? 'embed',
          capability: 'embed',
          provider: p.id,
          latencyMs: Math.round(performance.now() - started),
          outcome: 'error',
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no provider available for embed');
  }

  /** Streams from the first provider that starts without an error event. */
  async *chat(
    messages: AiMessage[],
    tools?: AiTool[],
    opts: CallOpts = {},
  ): AsyncIterable<AiChatEvent> {
    const feature = opts.feature ?? 'chat';
    let lastError: AiError = { code: 'no_provider', message: 'no provider available for chat' };
    for (const p of this.plan('chat', opts.allowCloud === true)) {
      const started = performance.now();
      let started_output = false;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      let failed: AiError | undefined;
      try {
        for await (const ev of p.chat(messages, tools, opts)) {
          if (ev.type === 'error' && !started_output) {
            failed = ev.error;
            break;
          }
          started_output = true;
          if (ev.type === 'done' && ev.usage) usage = ev.usage;
          yield ev;
          if (ev.type === 'error') break;
        }
      } catch (e) {
        failed = {
          code: 'unavailable',
          message: e instanceof Error ? e.message : String(e),
          retriable: true,
        };
        if (started_output) {
          yield { type: 'error', error: failed };
          return;
        }
      }
      await this.log({
        feature,
        capability: 'chat',
        provider: p.id,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        latencyMs: Math.round(performance.now() - started),
        outcome: failed ? failed.code : 'ok',
      });
      if (!failed) return;
      lastError = failed;
    }
    yield { type: 'error', error: lastError };
  }
}
