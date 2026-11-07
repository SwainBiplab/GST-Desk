/**
 * Tier 1 in the browser where WebGPU exists. The engine (`@mlc-ai/web-llm`'s `MLCEngine`) is passed in
 * by the app so this package carries no browser-only dependency; without WebGPU the app never makes one
 * and the router stays at Tier 0.
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

import { generateStructured, type ChatTurn, type Generate } from './structured';

/** The part of an OpenAI-style engine this provider uses. */
export interface WebLlmEngine {
  chat: {
    completions: {
      create(req: {
        messages: ChatTurn[];
        response_format?: { type: 'json_object'; schema?: string };
        temperature?: number;
        max_tokens?: number;
      }): Promise<{
        choices: { message: { content: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

export class WebLlmProvider extends BaseProvider {
  readonly id = 'webllm' as const;

  constructor(
    private readonly engine: WebLlmEngine,
    private readonly modelName: string,
  ) {
    super();
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['extract', 'suggest']);
  }

  private readonly generate: Generate = async (messages, constraint) => {
    const r = await this.engine.chat.completions.create({
      messages,
      response_format: { type: 'json_object', schema: JSON.stringify(constraint.jsonSchema) },
      temperature: 0.1,
      max_tokens: 768,
    });
    return {
      text: r.choices[0]?.message.content ?? '',
      usage: {
        ...(r.usage?.prompt_tokens !== undefined ? { inputTokens: r.usage.prompt_tokens } : {}),
        ...(r.usage?.completion_tokens !== undefined
          ? { outputTokens: r.usage.completion_tokens }
          : {}),
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
      model: this.modelName,
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
      model: this.modelName,
      schema,
      name: opts.schemaName ?? prompt.feature,
      text: prompt.text,
      input: prompt.input,
      signal: opts.signal,
    });
  }
}
