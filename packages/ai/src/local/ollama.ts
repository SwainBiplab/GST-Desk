/**
 * Tier 1 through a person's own Ollama. Structured output uses Ollama's `format` with a JSON schema.
 * The base URL is a setting; nothing is contacted unless the person chose this backend.
 */
import {
  BaseProvider,
  fail,
  type AiDocument,
  type AiPrompt,
  type AiResult,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type Schema,
} from '../provider';

import { postJson } from './runtime';
import { generateStructured, type Generate } from './structured';

export interface OllamaOptions {
  baseUrl?: string;
  model: string;
  embedModel?: string;
  fetchFn?: typeof fetch;
}

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama' as const;
  private readonly base: string;

  constructor(private readonly o: OllamaOptions) {
    super();
    this.base = (o.baseUrl ?? OLLAMA_DEFAULT_URL).replace(/\/$/, '');
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['extract', 'suggest', 'embed']);
  }

  /** Is Ollama answering, and which models does it hold? */
  async models(): Promise<string[]> {
    const res = await (this.o.fetchFn ?? fetch)(`${this.base}/api/tags`);
    if (!res.ok) throw new Error(`ollama answered ${res.status}`);
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  }

  private readonly generate: Generate = async (messages, constraint, signal) => {
    const r = await postJson<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>(
      `${this.base}/api/chat`,
      {
        model: this.o.model,
        messages,
        format: constraint.jsonSchema,
        stream: false,
        options: { temperature: 0.1, num_predict: 768 },
      },
      { ...(signal ? { signal } : {}), ...(this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {}) },
    );
    return {
      text: r.message?.content ?? '',
      usage: {
        ...(r.prompt_eval_count !== undefined ? { inputTokens: r.prompt_eval_count } : {}),
        ...(r.eval_count !== undefined ? { outputTokens: r.eval_count } : {}),
      },
    };
  };

  override extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts: ExtractOpts = {},
  ): Promise<AiResult<T>> {
    if (!doc.text) return Promise.resolve(fail('unsupported', 'needs text: run OCR first', true));
    return generateStructured({
      generate: this.generate,
      provider: this.id,
      model: this.o.model,
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
    return generateStructured({
      generate: this.generate,
      provider: this.id,
      model: this.o.model,
      schema,
      name: opts.schemaName ?? prompt.feature,
      text: prompt.text,
      input: prompt.input,
      signal: opts.signal,
    });
  }

  override async embed(texts: string[]): Promise<Float32Array[]> {
    const r = await postJson<{ embeddings?: number[][] }>(
      `${this.base}/api/embed`,
      { model: this.o.embedModel ?? this.o.model, input: texts },
      this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {},
    );
    const rows = r.embeddings ?? [];
    if (rows.length !== texts.length) throw new Error('embedding count mismatch');
    return rows.map((v) => Float32Array.from(v));
  }
}
