/**
 * Tier 2: Anthropic Claude through the official SDK (prompt 48). One provider instance per key: the cloud
 * gateway's own, or a person's own key on the desktop. Every answer is structured output checked against the
 * caller's Zod schema (nothing half-valid comes back), the system text and the business context are a stable,
 * cached prefix, personal identifiers in text are masked before they leave and put back in what comes back,
 * a refusal is `ok: false` and the next tier answers, and streaming is used for anything that may run long.
 * The model never computes tax: the engine prices every extraction again.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';

import {
  BaseProvider,
  fail,
  validated,
  type AiChatEvent,
  type AiDocument,
  type AiMessage,
  type AiPrompt,
  type AiResult,
  type AiTool,
  type AiUsage,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type Schema,
} from '../provider';
import { redact, type Redaction } from '../redact';

import { cloudPromptFor } from './prompts';

export const DEFAULT_CLOUD_MODEL = 'claude-opus-5-5';
export const CLOUD_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Opts into server-side fallbacks on a refusal, routed by category (no model list to keep). */
const BETAS = ['server-side-fallback-2026-07-01'];

export interface CloudRoute {
  model: string;
  /** Left unset the model's own default applies. */
  effort?: Effort | undefined;
  maxTokens?: number | undefined;
}

export interface AnthropicConfig {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** A person's own key in the desktop: the SDK refuses browser use unless told so. */
  dangerouslyAllowBrowser?: boolean | undefined;
  /** The model for every route not listed in `routes`. */
  model?: string | undefined;
  routes?: Record<string, Partial<CloudRoute>> | undefined;
  /** Stable context cached with the system prompt: a business profile line and an HSN excerpt. */
  context?: { profile?: string | undefined; hsnExcerpt?: string | undefined } | undefined;
  /** Mask PAN, bank account and Aadhaar numbers in text before it leaves (on by default). */
  redact?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

export interface Citation {
  documentIndex: number;
  title: string | null;
  citedText: string;
}

export interface CitedAnswer {
  text: string;
  citations: Citation[];
  usage: AiUsage;
  model: string;
  latencyMs: number;
}

export interface BatchItem {
  customId: string;
  feature: string;
  doc?: AiDocument | undefined;
  prompt?: AiPrompt | undefined;
  schema: Schema<unknown>;
}

export type BatchOutcome =
  | { customId: string; ok: true; value: unknown; usage: AiUsage }
  | { customId: string; ok: false; error: string };

const MAX_TOKENS: Record<string, number> = {
  bill_extract: 8_000,
  explain_2b_mismatch: 2_000,
  summarise_notice: 8_000,
  draft_message: 1_500,
  categorise_statement: 500,
  ask_books: 8_000,
  gst_qa: 6_000,
};

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * The output format for a Zod schema. Built here rather than with the SDK's parsing helper so the answer is
 * checked once, by `validated`, and a schema miss is `invalid_output` rather than a thrown parse error.
 */
export function outputFormat(schema: Schema<unknown>): {
  type: 'json_schema';
  schema: Record<string, unknown>;
} {
  const js = z.toJSONSchema(schema as never) as Record<string, unknown>;
  delete js['$schema'];
  return { type: 'json_schema', schema: js };
}

/** Every object strict (all keys required, no extras), as strict tools need. */
export function strictJsonSchema(schema: Schema<unknown>): Record<string, unknown> {
  const js = z.toJSONSchema(schema as never) as Record<string, unknown>;
  delete js['$schema'];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o['type'] === 'object' && o['properties'] && typeof o['properties'] === 'object') {
      o['required'] = Object.keys(o['properties'] as object);
      o['additionalProperties'] = false;
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(js);
  return js;
}

const toBase64 = (bytes: Uint8Array): string =>
  typeof Buffer !== 'undefined'
    ? Buffer.from(bytes).toString('base64')
    : btoa(String.fromCharCode(...bytes));

const usageOf = (m: { usage: BetaMessage['usage'] }): AiUsage => ({
  inputTokens: m.usage.input_tokens,
  outputTokens: m.usage.output_tokens,
  cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
});

const textOf = (m: BetaMessage): string =>
  m.content
    .filter((b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly c: AnthropicConfig = {}) {
    super();
    this.client = new Anthropic({
      ...(c.apiKey !== undefined ? { apiKey: c.apiKey } : {}),
      ...(c.baseUrl ? { baseURL: c.baseUrl } : {}),
      ...(c.fetch ? { fetch: c.fetch as never } : {}),
      ...(c.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
      ...(c.timeoutMs ? { timeout: c.timeoutMs } : {}),
      ...(c.maxRetries !== undefined ? { maxRetries: c.maxRetries } : {}),
    });
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['extract', 'suggest', 'chat']);
  }

  route(feature: string): CloudRoute {
    const r = this.c.routes?.[feature] ?? {};
    return {
      model: r.model ?? this.c.model ?? DEFAULT_CLOUD_MODEL,
      effort: r.effort,
      maxTokens: r.maxTokens ?? MAX_TOKENS[feature] ?? 4_000,
    };
  }

  /* ------------------------------------------------------------------------------ request parts */

  /**
   * The stable prefix: the route's system text, then the business context (the provider's own, or the
   * caller's `hints.profile` and `hints.hsnExcerpt` when the gateway serves many businesses), the last block
   * cached.
   */
  private system(
    feature: string,
    extra?: string,
    hints?: Record<string, unknown> | undefined,
  ): BetaTextBlockParam[] {
    const parts: string[] = [cloudPromptFor(feature).system];
    const profile =
      typeof hints?.['profile'] === 'string' ? hints['profile'] : this.c.context?.profile;
    const hsn =
      typeof hints?.['hsnExcerpt'] === 'string' ? hints['hsnExcerpt'] : this.c.context?.hsnExcerpt;
    if (profile) parts.push(`The business:\n${profile}`);
    if (hsn) parts.push(`HSN and SAC codes this business uses:\n${hsn}`);
    if (extra) parts.push(extra);
    return parts.map((text, i) => ({
      type: 'text',
      text,
      ...(i === parts.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
  }

  private mask(text: string | undefined): { text: string | undefined; r: Redaction | null } {
    if (!text || this.c.redact === false) return { text, r: null };
    const r = redact(text);
    return { text: r.text, r };
  }

  private docBlocks(
    doc: AiDocument,
    feature: string,
    r: Redaction | null,
  ): BetaContentBlockParam[] {
    const blocks: BetaContentBlockParam[] = [];
    if (doc.bytes && doc.kind === 'image') {
      const mime = doc.mime && IMAGE_MIME.has(doc.mime) ? doc.mime : 'image/png';
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime as never, data: toBase64(doc.bytes) },
      });
    } else if (doc.bytes && doc.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: toBase64(doc.bytes) },
        ...(doc.name ? { title: doc.name.slice(0, 200) } : {}),
      });
    }
    const spec = cloudPromptFor(feature);
    blocks.push({ type: 'text', text: spec.user({ text: r ? r.text : doc.text }) });
    return blocks;
  }

  /* ------------------------------------------------------------------------------- one call */

  private async call(
    feature: string,
    params: {
      system?: BetaTextBlockParam[];
      messages: BetaMessageParam[];
      format?: Schema<unknown> | undefined;
      tools?: BetaTool[] | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<
    | { ok: true; message: BetaMessage; latencyMs: number }
    | { ok: false; result: { ok: false; error: { code: never } } }
    | { ok: false; result: AiResult<never> }
  > {
    const route = this.route(feature);
    const started = performance.now();
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: route.model,
          max_tokens: route.maxTokens ?? 4_000,
          betas: BETAS,
          fallbacks: 'default',
          ...(params.system ? { system: params.system } : {}),
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools } : {}),
          ...(route.effort || params.format
            ? {
                output_config: {
                  ...(route.effort ? { effort: route.effort } : {}),
                  ...(params.format ? { format: outputFormat(params.format) } : {}),
                },
              }
            : {}),
        },
        params.signal ? { signal: params.signal } : undefined,
      );
      const message = await stream.finalMessage();
      const latencyMs = Math.round(performance.now() - started);
      if (message.stop_reason === 'refusal') {
        const why = message.stop_details?.category ?? 'policy';
        return {
          ok: false,
          result: fail(
            'refused',
            `The cloud model declined this request (${why}). The offline tiers will answer instead.`,
          ),
        };
      }
      if (message.stop_reason === 'max_tokens')
        return {
          ok: false,
          result: fail('invalid_output', 'The answer was cut off at the token limit.', false),
        };
      return { ok: true, message, latencyMs };
    } catch (e) {
      if (params.signal?.aborted)
        return { ok: false, result: fail('cancelled', 'request cancelled') };
      if (e instanceof Anthropic.RateLimitError)
        return { ok: false, result: fail('unavailable', 'The cloud model is rate limited.', true) };
      if (e instanceof Anthropic.AuthenticationError)
        return { ok: false, result: fail('unavailable', 'The cloud API key was not accepted.') };
      if (e instanceof Anthropic.APIError)
        return {
          ok: false,
          result: fail(
            'unavailable',
            `The cloud model answered ${e.status ?? 'an error'}: ${e.message}`,
            (e.status ?? 500) >= 500,
          ),
        };
      return {
        ok: false,
        result: fail(
          'unavailable',
          `The cloud model could not be reached: ${e instanceof Error ? e.message : String(e)}`,
          true,
        ),
      };
    }
  }

  private parsed<T>(
    schema: Schema<T>,
    message: BetaMessage,
    r: Redaction | null,
    latencyMs: number,
  ): AiResult<T> {
    const raw = r ? r.restore(textOf(message)) : textOf(message);
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return fail('invalid_output', 'The cloud model did not answer with JSON.');
    }
    return validated(schema, candidate, {
      provider: this.id,
      model: message.model,
      confidence: 0.9,
      usage: usageOf(message),
      latencyMs,
    });
  }

  /* ------------------------------------------------------------------------- the capabilities */

  override async extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts: ExtractOpts = {},
  ): Promise<AiResult<T>> {
    const feature = opts.feature ?? 'bill_extract';
    const { r } = this.mask(doc.text);
    const out = await this.call(feature, {
      system: this.system(feature, undefined, opts.hints),
      messages: [{ role: 'user', content: this.docBlocks(doc, feature, r) }],
      format: schema,
      signal: opts.signal,
    });
    if (!out.ok) return out.result as AiResult<T>;
    return this.parsed(schema, out.message, r, out.latencyMs);
  }

  override async suggest<T>(
    prompt: AiPrompt,
    schema: Schema<T>,
    opts: CallOpts = {},
  ): Promise<AiResult<T>> {
    const spec = cloudPromptFor(prompt.feature);
    const { text, r } = this.mask(
      prompt.text ?? (prompt.input === undefined ? undefined : JSON.stringify(prompt.input)),
    );
    const out = await this.call(prompt.feature, {
      system: this.system(prompt.feature, undefined, opts.hints),
      messages: [
        {
          role: 'user',
          content: spec.user(
            prompt.text !== undefined
              ? { text, input: prompt.input }
              : { input: text === undefined ? prompt.input : JSON.parse(text) },
          ),
        },
      ],
      format: schema,
      signal: opts.signal,
    });
    if (!out.ok) return out.result as AiResult<T>;
    return this.parsed(schema, out.message, r, out.latencyMs);
  }

  /**
   * A conversation with tools, streamed. Tools are declared strict; the model is never forced to call one.
   * A `tool_call` event names the call's id; the caller answers with a `tool` message carrying `toolCallId`.
   */
  override async *chat(
    messages: AiMessage[],
    tools: AiTool[] = [],
    opts: CallOpts = {},
  ): AsyncIterable<AiChatEvent> {
    const feature = opts.feature ?? 'ask_books';
    const route = this.route(feature);
    const systemExtra = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const betaTools: BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: strictJsonSchema(t.parameters) as never,
      strict: true,
    }));
    const params: BetaMessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const { text } = this.mask(m.content);
        params.push({ role: 'user', content: text ?? '' });
      } else if (m.role === 'assistant') {
        const content: (BetaTextBlockParam | BetaToolUseBlockParam)[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? [])
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        params.push({ role: 'assistant', content });
      } else {
        // every tool result of a turn goes in one user message
        const block: BetaToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        };
        const last = params.at(-1);
        if (last && last.role === 'user' && Array.isArray(last.content))
          (last.content as BetaContentBlockParam[]).push(block);
        else params.push({ role: 'user', content: [block] });
      }
    }
    const started = performance.now();
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: route.model,
          max_tokens: route.maxTokens ?? 4_000,
          betas: BETAS,
          fallbacks: 'default',
          system: this.system(feature, systemExtra || undefined, opts.hints),
          messages: params,
          ...(betaTools.length ? { tools: betaTools } : {}),
          ...(route.effort ? { output_config: { effort: route.effort } } : {}),
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
          yield { type: 'text', delta: ev.delta.text };
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        yield {
          type: 'error',
          error: {
            code: 'refused',
            message: `The cloud model declined this request (${message.stop_details?.category ?? 'policy'}).`,
          },
        };
        return;
      }
      for (const b of message.content)
        if (b.type === 'tool_use')
          yield { type: 'tool_call', id: b.id, name: b.name, arguments: b.input };
      yield { type: 'done', usage: usageOf(message) };
    } catch (e) {
      yield {
        type: 'error',
        error: {
          code: 'unavailable',
          message: e instanceof Error ? e.message : String(e),
          retriable: !(e instanceof Anthropic.APIError) || (e.status ?? 500) >= 500,
        },
      };
    }
    void started;
  }

  /** A question answered over documents, with the model's citations (the GST Q&A route). */
  async answerWithCitations(
    question: string,
    docs: { title: string; text: string }[],
    opts: CallOpts = {},
  ): Promise<AiResult<CitedAnswer>> {
    const feature = opts.feature ?? 'gst_qa';
    const { text, r } = this.mask(question);
    const content: BetaContentBlockParam[] = docs.map((d) => ({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: d.text },
      title: d.title.slice(0, 200),
      citations: { enabled: true },
    }));
    content.push({ type: 'text', text: cloudPromptFor(feature).user({ text }) });
    const out = await this.call(feature, {
      system: this.system(feature, undefined, opts.hints),
      messages: [{ role: 'user', content }],
      signal: opts.signal,
    });
    if (!out.ok) return out.result as AiResult<CitedAnswer>;
    const citations: Citation[] = [];
    let answer = '';
    for (const b of out.message.content) {
      if (b.type !== 'text') continue;
      answer += b.text;
      for (const c of b.citations ?? [])
        if ('document_index' in c)
          citations.push({
            documentIndex: c.document_index,
            title: c.document_title ?? null,
            citedText: c.cited_text,
          });
    }
    return {
      ok: true,
      value: {
        text: r ? r.restore(answer) : answer,
        citations,
        usage: usageOf(out.message),
        model: out.message.model,
        latencyMs: out.latencyMs,
      },
      confidence: 0.9,
      provider: this.id,
      model: out.message.model,
      usage: usageOf(out.message),
      latencyMs: out.latencyMs,
    };
  }

  /* ------------------------------------------------------------------------------------- batches */

  /** Many extractions or categorisations as one Message Batch (half price, up to a day). */
  async createBatch(items: BatchItem[]): Promise<{ id: string; count: number }> {
    const requests = items.map((it) => {
      const route = this.route(it.feature);
      const spec = cloudPromptFor(it.feature);
      const content: BetaContentBlockParam[] = it.doc
        ? this.docBlocks(it.doc, it.feature, this.mask(it.doc.text).r)
        : [{ type: 'text', text: spec.user({ text: it.prompt?.text, input: it.prompt?.input }) }];
      return {
        custom_id: it.customId,
        params: {
          model: route.model,
          max_tokens: route.maxTokens ?? 4_000,
          system: this.system(it.feature) as never,
          messages: [{ role: 'user' as const, content: content as never }],
          output_config: {
            ...(route.effort ? { effort: route.effort } : {}),
            format: outputFormat(it.schema),
          },
        },
      };
    });
    const b = await this.client.messages.batches.create({ requests: requests as never });
    return { id: b.id, count: requests.length };
  }

  async batchStatus(id: string): Promise<{
    ended: boolean;
    counts: {
      processing: number;
      succeeded: number;
      errored: number;
      expired: number;
      canceled: number;
    };
  }> {
    const b = await this.client.messages.batches.retrieve(id);
    return { ended: b.processing_status === 'ended', counts: b.request_counts };
  }

  /** The results of an ended batch, each checked against its item's schema (keyed by custom id, any order). */
  async batchResults(id: string, items: BatchItem[]): Promise<BatchOutcome[]> {
    const byId = new Map(items.map((i) => [i.customId, i]));
    const out: BatchOutcome[] = [];
    for await (const r of await this.client.messages.batches.results(id)) {
      const item = byId.get(r.custom_id);
      if (!item) continue;
      if (r.result.type !== 'succeeded') {
        out.push({
          customId: r.custom_id,
          ok: false,
          error: r.result.type === 'errored' ? r.result.error.type : r.result.type,
        });
        continue;
      }
      const m = r.result.message;
      if (m.stop_reason === 'refusal') {
        out.push({ customId: r.custom_id, ok: false, error: 'refused' });
        continue;
      }
      const text = m.content
        .filter(
          (b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text',
        )
        .map((b) => b.text)
        .join('');
      let candidate: unknown;
      try {
        candidate = JSON.parse(text);
      } catch {
        out.push({ customId: r.custom_id, ok: false, error: 'not json' });
        continue;
      }
      const v = validated(item.schema, candidate, {
        provider: this.id,
        model: m.model,
        confidence: 0.9,
        latencyMs: 0,
      });
      out.push(
        v.ok
          ? {
              customId: r.custom_id,
              ok: true,
              value: v.value,
              usage: {
                inputTokens: m.usage.input_tokens,
                outputTokens: m.usage.output_tokens,
                cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
              },
            }
          : { customId: r.custom_id, ok: false, error: v.error.message },
      );
    }
    return out;
  }
}
