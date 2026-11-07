/**
 * Tier 1 on the desktop: llama.cpp's server for text and embeddings, whisper.cpp's server for speech,
 * each started on demand by a `Keeper` and stopped when idle. JSON output is forced with a grammar made
 * from the schema. Nothing leaves the computer: both servers listen on localhost only.
 */
import { z } from 'zod';

import {
  BaseProvider,
  fail,
  validated,
  type AiAudio,
  type AiDocument,
  type AiPrompt,
  type AiResult,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type Schema,
} from '../provider';

import type { Keeper } from './runtime';
import { postJson } from './runtime';
import { generateStructured, type ChatTurn, type Generate } from './structured';

export interface LocalLlamaOptions {
  /** The text model's server. */
  llm?: Keeper;
  /** A separate embedding model's server; falls back to the text model's `/v1/embeddings`. */
  embedder?: Keeper;
  /** whisper.cpp server. */
  whisper?: Keeper;
  modelName: string;
  embedModelName?: string;
  whisperModelName?: string;
  fetchFn?: typeof fetch;
  /** Generation settings; small by default so a 1.5B model answers in seconds. */
  maxTokens?: number;
  temperature?: number;
}

const transcriptSchema = z.object({ text: z.string() });

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LocalLlamaProvider extends BaseProvider {
  readonly id = 'local-llama' as const;

  constructor(private readonly o: LocalLlamaOptions) {
    super();
  }

  capabilities(): Set<Capability> {
    const c = new Set<Capability>();
    if (this.o.llm) c.add('extract').add('suggest').add('embed');
    if (this.o.embedder) c.add('embed');
    if (this.o.whisper) c.add('transcribe');
    return c;
  }

  private generate(signal?: AbortSignal): Generate {
    return (messages: ChatTurn[], constraint, sig) =>
      this.o.llm!.withServer(async (h) => {
        const r = await postJson<ChatResponse>(
          `${h.baseUrl}/v1/chat/completions`,
          {
            messages,
            grammar: constraint.grammar,
            max_tokens: this.o.maxTokens ?? 768,
            temperature: this.o.temperature ?? 0.1,
            cache_prompt: true,
            stream: false,
          },
          {
            ...((sig ?? signal) ? { signal: sig ?? signal } : {}),
            ...(this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {}),
          },
        );
        return {
          text: r.choices?.[0]?.message?.content ?? '',
          usage: {
            ...(r.usage?.prompt_tokens !== undefined ? { inputTokens: r.usage.prompt_tokens } : {}),
            ...(r.usage?.completion_tokens !== undefined
              ? { outputTokens: r.usage.completion_tokens }
              : {}),
          },
        };
      }, sig ?? signal);
  }

  override extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts: ExtractOpts = {},
  ): Promise<AiResult<T>> {
    if (!this.o.llm) return Promise.resolve(fail('unsupported', 'no text model'));
    if (!doc.text) return Promise.resolve(fail('unsupported', 'needs text: run OCR first', true));
    return generateStructured({
      generate: this.generate(opts.signal),
      provider: this.id,
      model: this.o.modelName,
      schema,
      name: opts.schemaName ?? opts.feature,
      text: doc.text,
      signal: opts.signal,
    });
  }

  override suggest<T>(
    prompt: AiPrompt,
    schema: Schema<T>,
    opts: CallOpts = {},
  ): Promise<AiResult<T>> {
    if (!this.o.llm) return Promise.resolve(fail('unsupported', 'no text model'));
    return generateStructured({
      generate: this.generate(opts.signal),
      provider: this.id,
      model: this.o.modelName,
      schema,
      name: opts.schemaName ?? prompt.feature,
      text: prompt.text,
      input: prompt.input,
      signal: opts.signal,
    });
  }

  override async embed(texts: string[]): Promise<Float32Array[]> {
    const k = this.o.embedder ?? this.o.llm;
    if (!k) throw new Error('no embedding model');
    return k.withServer(async (h) => {
      const r = await postJson<{ data?: { embedding: number[]; index?: number }[] }>(
        `${h.baseUrl}/v1/embeddings`,
        { input: texts, model: this.o.embedModelName ?? this.o.modelName },
        this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {},
      );
      const rows = [...(r.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length) throw new Error('embedding count mismatch');
      return rows.map((d) => Float32Array.from(d.embedding));
    });
  }

  override async transcribe(
    audio: AiAudio,
    opts: { language?: string } = {},
  ): Promise<AiResult<{ text: string }>> {
    if (!this.o.whisper) return fail('unsupported', 'no speech model');
    const started = performance.now();
    try {
      const text = await this.o.whisper.withServer(async (h) => {
        const form = new FormData();
        form.append('file', new Blob([audio.bytes as BlobPart], { type: audio.mime }), 'audio.wav');
        form.append('response_format', 'json');
        form.append('temperature', '0');
        if (opts.language) form.append('language', opts.language);
        const res = await (this.o.fetchFn ?? fetch)(`${h.baseUrl}/inference`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) throw new Error(`whisper answered ${res.status}`);
        const j = (await res.json()) as { text?: string };
        return (j.text ?? '').trim();
      });
      return validated(
        transcriptSchema,
        { text },
        {
          provider: this.id,
          model: this.o.whisperModelName ?? 'whisper',
          confidence: text ? 0.8 : 0.1,
          latencyMs: Math.round(performance.now() - started),
        },
      );
    } catch (e) {
      return fail('unavailable', e instanceof Error ? e.message : String(e), true);
    }
  }
}
