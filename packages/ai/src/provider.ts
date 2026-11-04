import type { z } from 'zod';

export type ProviderId = 'rules' | 'local-llama' | 'ollama' | 'webllm' | 'anthropic' | 'mock';
export type Capability = 'extract' | 'suggest' | 'embed' | 'transcribe' | 'chat';

/** Callers pass a Zod schema; providers return values that pass it, or `ok: false`. */
export type Schema<T> = z.ZodType<T>;

export interface AiDocument {
  kind: 'text' | 'image' | 'pdf';
  /** Text content, or OCR/extracted text when available. */
  text?: string;
  bytes?: Uint8Array;
  mime?: string;
  name?: string;
}

export interface AiPrompt {
  /** Feature id, e.g. `hsn_lookup` or `duplicate_party`. Used for routing rules and the call log. */
  feature: string;
  /** Structured input for the feature. */
  input?: unknown;
  text?: string;
}

export interface AiAudio {
  bytes: Uint8Array;
  mime: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface AiTool {
  name: string;
  description: string;
  parameters: Schema<unknown>;
}

export type AiErrorCode =
  | 'unsupported'
  | 'invalid_output'
  | 'unavailable'
  | 'cloud_not_allowed'
  | 'cancelled'
  | 'rule_failed'
  | 'no_provider';

export interface AiError {
  code: AiErrorCode;
  message: string;
  /** True when trying the next provider may succeed. */
  retriable?: boolean;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type AiResult<T> =
  | {
      ok: true;
      value: T;
      /** 0..1 */
      confidence: number;
      fieldConfidence?: Record<string, number>;
      provider: string;
      model: string;
      usage?: AiUsage;
      latencyMs: number;
    }
  | { ok: false; error: AiError };

export interface CallOpts {
  /** Feature name for logging when the prompt has none (extract). */
  feature?: string;
  /** Name used by fixtures and evals to look up canned results. */
  schemaName?: string;
  /** The caller consents to sending this request to a cloud provider. */
  allowCloud?: boolean | undefined;
  signal?: AbortSignal;
  hints?: Record<string, unknown>;
}

export type ExtractOpts = CallOpts;

export type AiChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; arguments: unknown }
  | { type: 'done'; usage?: AiUsage }
  | { type: 'error'; error: AiError };

export interface AiProvider {
  readonly id: ProviderId;
  capabilities(): Set<Capability>;
  extract<T>(doc: AiDocument, schema: Schema<T>, opts?: ExtractOpts): Promise<AiResult<T>>;
  suggest<T>(prompt: AiPrompt, schema: Schema<T>, opts?: CallOpts): Promise<AiResult<T>>;
  embed(texts: string[]): Promise<Float32Array[]>;
  transcribe(audio: AiAudio, opts?: { language?: string }): Promise<AiResult<{ text: string }>>;
  chat(messages: AiMessage[], tools?: AiTool[], opts?: CallOpts): AsyncIterable<AiChatEvent>;
}

export const fail = (
  code: AiErrorCode,
  message: string,
  retriable = false,
): { ok: false; error: AiError } => ({
  ok: false,
  error: { code, message, retriable },
});

/**
 * Validate a candidate against the caller's schema. Returns the parsed value on success and a
 * non-retriable `invalid_output` failure otherwise, so partially valid objects never leak.
 */
export function validated<T>(
  schema: Schema<T>,
  candidate: unknown,
  meta: {
    provider: string;
    model: string;
    confidence: number;
    fieldConfidence?: Record<string, number>;
    usage?: AiUsage;
    latencyMs: number;
  },
): AiResult<T> {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return fail(
      'invalid_output',
      `output failed validation${where}: ${first?.message ?? 'unknown'}`,
    );
  }
  return {
    ok: true,
    value: parsed.data,
    confidence: Math.min(1, Math.max(0, meta.confidence)),
    ...(meta.fieldConfidence ? { fieldConfidence: meta.fieldConfidence } : {}),
    provider: meta.provider,
    model: meta.model,
    ...(meta.usage ? { usage: meta.usage } : {}),
    latencyMs: meta.latencyMs,
  };
}

/** Base class for backends that only implement some capabilities. */
export abstract class BaseProvider implements AiProvider {
  abstract readonly id: ProviderId;
  abstract capabilities(): Set<Capability>;

  extract<T>(_doc: AiDocument, _schema: Schema<T>, _opts?: ExtractOpts): Promise<AiResult<T>> {
    return Promise.resolve(fail('unsupported', `${this.id} does not support extract`));
  }
  suggest<T>(_prompt: AiPrompt, _schema: Schema<T>, _opts?: CallOpts): Promise<AiResult<T>> {
    return Promise.resolve(fail('unsupported', `${this.id} does not support suggest`));
  }
  embed(_texts: string[]): Promise<Float32Array[]> {
    return Promise.reject(new Error(`${this.id} does not support embed`));
  }
  transcribe(_audio: AiAudio, _opts?: { language?: string }): Promise<AiResult<{ text: string }>> {
    return Promise.resolve(fail('unsupported', `${this.id} does not support transcribe`));
  }

  async *chat(_m: AiMessage[], _t?: AiTool[], _o?: CallOpts): AsyncIterable<AiChatEvent> {
    yield {
      type: 'error',
      error: { code: 'unsupported', message: `${this.id} does not support chat` },
    };
  }
}
