import {
  BaseProvider,
  fail,
  validated,
  type AiAudio,
  type AiChatEvent,
  type AiDocument,
  type AiMessage,
  type AiPrompt,
  type AiResult,
  type CallOpts,
  type Capability,
  type ExtractOpts,
  type Schema,
} from './provider';

/** A canned value, or a function of the input. Wrap in `{ value, confidence }` to set confidence. */
export type Canned = unknown | ((input: unknown) => unknown);

export interface CannedResult {
  value: unknown;
  confidence?: number;
  fieldConfidence?: Record<string, number>;
}

export interface MockFixtures {
  /** Canned results keyed by schema name (`opts.schemaName`, else the schema description). */
  [schemaName: string]: Canned;
}

function schemaNameOf(schema: Schema<unknown>, opts?: CallOpts): string | undefined {
  return opts?.schemaName ?? (schema as { description?: string }).description;
}

const isCannedResult = (v: unknown): v is CannedResult =>
  typeof v === 'object' &&
  v !== null &&
  'value' in v &&
  Object.keys(v).every((k) => ['value', 'confidence', 'fieldConfidence'].includes(k));

/** Test double: returns canned results by schema name, still validated like a real backend. */
export class MockProvider extends BaseProvider {
  readonly id = 'mock' as const;
  readonly calls: { capability: Capability; schemaName?: string }[] = [];

  constructor(
    private readonly fixtures: MockFixtures = {},
    private readonly extra: { transcript?: string; chat?: string; model?: string } = {},
  ) {
    super();
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['extract', 'suggest', 'embed', 'transcribe', 'chat']);
  }

  private resolve<T>(
    capability: Capability,
    input: unknown,
    schema: Schema<T>,
    opts?: CallOpts,
  ): AiResult<T> {
    const name = schemaNameOf(schema, opts);
    this.calls.push({ capability, ...(name ? { schemaName: name } : {}) });
    const canned = name ? this.fixtures[name] : undefined;
    if (canned === undefined)
      return fail('unsupported', `mock has no fixture for "${name ?? 'unnamed schema'}"`);
    const raw = typeof canned === 'function' ? (canned as (i: unknown) => unknown)(input) : canned;
    const result: CannedResult = isCannedResult(raw) ? raw : { value: raw };
    return validated(schema, result.value, {
      provider: this.id,
      model: this.extra.model ?? 'mock-1',
      confidence: result.confidence ?? 1,
      ...(result.fieldConfidence ? { fieldConfidence: result.fieldConfidence } : {}),
      latencyMs: 0,
    });
  }

  override async extract<T>(
    doc: AiDocument,
    schema: Schema<T>,
    opts?: ExtractOpts,
  ): Promise<AiResult<T>> {
    return this.resolve('extract', doc, schema, opts);
  }

  override async suggest<T>(
    prompt: AiPrompt,
    schema: Schema<T>,
    opts?: CallOpts,
  ): Promise<AiResult<T>> {
    return this.resolve('suggest', prompt, schema, opts);
  }

  /** Deterministic 8-dimension vectors derived from the text. */
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push({ capability: 'embed' });
    return texts.map((t) => {
      const v = new Float32Array(8);
      for (let i = 0; i < t.length; i++) v[i % 8]! += t.charCodeAt(i) / 1000;
      return v;
    });
  }

  override async transcribe(_audio: AiAudio): Promise<AiResult<{ text: string }>> {
    this.calls.push({ capability: 'transcribe' });
    return {
      ok: true,
      value: { text: this.extra.transcript ?? 'mock transcript' },
      confidence: 1,
      provider: this.id,
      model: this.extra.model ?? 'mock-1',
      latencyMs: 0,
    };
  }

  override async *chat(_messages: AiMessage[]): AsyncIterable<AiChatEvent> {
    this.calls.push({ capability: 'chat' });
    for (const word of (this.extra.chat ?? 'mock reply').split(' '))
      yield { type: 'text', delta: `${word} ` };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 2 } };
  }
}
