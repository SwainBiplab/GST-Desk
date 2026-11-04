import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AiRouter,
  BaseProvider,
  MockProvider,
  RulesProvider,
  fail,
  type AiChatEvent,
  type AiPrompt,
  type AiProvider,
  type AiResult,
  type CallLogEntry,
  type CallOpts,
  type Capability,
  type ProviderId,
  type RouterSettings,
  type Schema,
} from '../src';

const schema = z.object({ answer: z.string() });

/** Scriptable backend that records how often it was called. */
class Fake extends BaseProvider {
  calls = 0;
  constructor(
    readonly id: ProviderId,
    private readonly behaviour: 'ok' | 'error' | 'throw' | 'bad-output' = 'ok',
    private readonly caps: Capability[] = ['suggest', 'extract', 'embed', 'transcribe', 'chat'],
  ) {
    super();
  }
  capabilities() {
    return new Set(this.caps);
  }
  private run<T>(schema: Schema<T>): AiResult<T> {
    this.calls += 1;
    if (this.behaviour === 'throw') throw new Error('boom');
    if (this.behaviour === 'error') return fail('unavailable', 'down', true);
    const parsed = schema.safeParse(
      this.behaviour === 'bad-output' ? { nope: 1 } : { answer: this.id },
    );
    return parsed.success
      ? {
          ok: true,
          value: parsed.data,
          confidence: 0.9,
          provider: this.id,
          model: `${this.id}-m`,
          usage: { inputTokens: 3, outputTokens: 4 },
          latencyMs: 2,
        }
      : fail('invalid_output', 'bad');
  }
  override async suggest<T>(_p: AiPrompt, s: Schema<T>, _o?: CallOpts) {
    return this.run(s);
  }
  override async extract<T>(_d: never, s: Schema<T>) {
    return this.run(s);
  }
  override async embed(texts: string[]) {
    this.calls += 1;
    if (this.behaviour !== 'ok') throw new Error('embed down');
    return texts.map(() => new Float32Array([this.id.length]));
  }
  override async *chat(): AsyncIterable<AiChatEvent> {
    this.calls += 1;
    if (this.behaviour === 'error') {
      yield { type: 'error', error: { code: 'unavailable', message: 'down' } };
      return;
    }
    if (this.behaviour === 'throw') throw new Error('boom');
    yield { type: 'text', delta: this.id };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const settings = (over: Partial<RouterSettings> = {}): RouterSettings => ({
  tier0: true,
  tier1: 'ollama',
  tier2: 'anthropic',
  askBeforeCloud: true,
  ...over,
});

const prompt: AiPrompt = { feature: 'test_feature' };

describe('AiRouter', () => {
  it('can be built with only the rules and mock providers', async () => {
    const router = new AiRouter({
      settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
      providers: [new RulesProvider(), new MockProvider({ thing: { answer: 'x' } })],
    });
    const r = await router.suggest(prompt, schema, { schemaName: 'thing' });
    expect(r.ok && r.provider).toBe('mock');
  });

  it('falls back down the tiers in order', async () => {
    const t2 = new Fake('anthropic', 'error');
    const t1 = new Fake('ollama', 'error');
    const t0 = new Fake('rules', 'ok');
    const router = new AiRouter({ settings: settings(), providers: [t0, t1, t2] });
    const r = await router.suggest(prompt, schema, { allowCloud: true });
    expect(r.ok && r.provider).toBe('rules');
    expect([t2.calls, t1.calls, t0.calls]).toEqual([1, 1, 1]);
  });

  it('prefers the best allowed tier when it works', async () => {
    const t2 = new Fake('anthropic');
    const t1 = new Fake('ollama');
    const t0 = new Fake('rules');
    const router = new AiRouter({ settings: settings(), providers: [t0, t1, t2] });
    const r = await router.suggest(prompt, schema, { allowCloud: true });
    expect(r.ok && r.provider).toBe('anthropic');
    expect([t1.calls, t0.calls]).toEqual([0, 0]);
  });

  it('never calls Tier 2 without allowCloud', async () => {
    const t2 = new Fake('anthropic');
    const t1 = new Fake('ollama', 'error');
    const t0 = new Fake('rules', 'error');
    const router = new AiRouter({
      settings: settings({ askBeforeCloud: false }),
      providers: [t0, t1, t2],
    });
    for (const opts of [{}, { allowCloud: false }, { allowCloud: undefined }]) {
      const r = await router.suggest(prompt, schema, opts);
      expect(r.ok).toBe(false);
    }
    await router.extract({ kind: 'text', text: 'x' }, schema);
    await router.embed(['x']).catch(() => undefined);
    for await (const _ of router.chat([{ role: 'user', content: 'hi' }])) void _;
    await router.transcribe({ bytes: new Uint8Array(), mime: 'audio/wav' });
    expect(t2.calls).toBe(0);
    expect(router.cloudAvailable('suggest')).toBe(true);
    expect(router.plan('suggest', false).map((p) => p.id)).toEqual(['ollama', 'rules']);
    expect(router.plan('suggest', true).map((p) => p.id)).toEqual(['anthropic', 'ollama', 'rules']);
  });

  it('skips a backend that does not fit the hardware', () => {
    const providers = [new Fake('local-llama'), new Fake('rules')];
    const low = new AiRouter({
      settings: settings({ tier1: 'local-llama', tier2: null }),
      providers,
      hardware: { ramGb: 4, cores: 2 },
    });
    expect(low.plan('suggest').map((p) => p.id)).toEqual(['rules']);
    const high = new AiRouter({
      settings: settings({ tier1: 'local-llama', tier2: null }),
      providers,
      hardware: { ramGb: 16, cores: 8 },
    });
    expect(high.plan('suggest').map((p) => p.id)).toEqual(['local-llama', 'rules']);
    const webllm = new AiRouter({
      settings: settings({ tier1: 'webllm', tier2: null }),
      providers: [new Fake('webllm')],
      hardware: { ramGb: 16, cores: 8, gpu: false },
    });
    expect(webllm.plan('suggest')).toEqual([]);
  });

  it('only plans providers that have the capability', () => {
    const router = new AiRouter({
      settings: settings(),
      providers: [new RulesProvider(), new Fake('ollama', 'ok', ['chat'])],
    });
    expect(router.plan('chat').map((p) => p.id)).toEqual(['ollama']);
    expect(router.plan('suggest').map((p) => p.id)).toEqual(['rules']);
    expect(router.plan('transcribe')).toEqual([]);
  });

  it('treats thrown errors and invalid output as reasons to fall back', async () => {
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'throw'), new Fake('rules', 'ok')],
    });
    expect((await router.suggest(prompt, schema)).ok).toBe(true);
    const bad = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'bad-output'), new Fake('rules', 'bad-output')],
    });
    const r = await bad.suggest(prompt, schema);
    expect(!r.ok && r.error.code).toBe('invalid_output');
  });

  it('reports no_provider and cancellation', async () => {
    const empty = new AiRouter({
      settings: settings({ tier0: false, tier1: null, tier2: null }),
      providers: [],
    });
    const r = await empty.suggest(prompt, schema);
    expect(!r.ok && r.error.code).toBe('no_provider');
    const router = new AiRouter({ settings: settings(), providers: [new Fake('rules')] });
    const ctrl = new AbortController();
    ctrl.abort();
    const c = await router.suggest(prompt, schema, { signal: ctrl.signal });
    expect(!c.ok && c.error.code).toBe('cancelled');
  });

  it('prefers the informative error over "unsupported"', async () => {
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'error'), new RulesProvider()],
    });
    const r = await router.suggest({ feature: 'unknown' }, schema);
    expect(!r.ok && r.error.code).toBe('unavailable');
  });

  it('logs metadata for every attempt, never content', async () => {
    const log: CallLogEntry[] = [];
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'error'), new Fake('rules')],
      logger: { log: (e) => void log.push(e) },
    });
    await router.suggest({ feature: 'hsn_lookup', input: { description: 'SECRET TEXT' } }, schema);
    expect(log.map((l) => [l.provider, l.outcome])).toEqual([
      ['ollama', 'unavailable'],
      ['rules', 'ok'],
    ]);
    expect(log[1]).toMatchObject({
      feature: 'hsn_lookup',
      capability: 'suggest',
      model: 'rules-m',
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(JSON.stringify(log)).not.toContain('SECRET');
  });

  it('survives a failing logger', async () => {
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('rules')],
      logger: { log: () => Promise.reject(new Error('disk full')) },
    });
    expect((await router.suggest(prompt, schema)).ok).toBe(true);
  });

  it('embeds with fallback and throws when nothing works', async () => {
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'throw'), new Fake('rules', 'ok')],
    });
    expect((await router.embed(['a']))[0]?.[0]).toBe(5);
    const none = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('rules', 'throw')],
    });
    await expect(none.embed(['a'])).rejects.toThrow(/embed down/);
    const empty = new AiRouter({
      settings: settings({ tier0: false, tier1: null, tier2: null }),
      providers: [],
    });
    await expect(empty.embed(['a'])).rejects.toThrow(/no provider/);
  });

  it('streams chat from the first provider that starts cleanly', async () => {
    const log: CallLogEntry[] = [];
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'error'), new Fake('rules', 'ok')],
      logger: { log: (e) => void log.push(e) },
    });
    const events: AiChatEvent[] = [];
    for await (const e of router.chat([{ role: 'user', content: 'hi' }])) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(log.map((l) => l.outcome)).toEqual(['unavailable', 'ok']);

    const down = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new Fake('ollama', 'throw')],
    });
    const out: AiChatEvent[] = [];
    for await (const e of down.chat([{ role: 'user', content: 'hi' }])) out.push(e);
    expect(out).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'unavailable' }) },
    ]);
  });

  it('transcribes through the chain', async () => {
    const router = new AiRouter({
      settings: settings({ tier2: null }),
      providers: [new MockProvider({}, { transcript: 'namaste' })],
    });
    const r = await router.transcribe(
      { bytes: new Uint8Array(), mime: 'audio/wav' },
      { language: 'hi' },
    );
    expect(r.ok && r.value.text).toBe('namaste');
  });
});

describe('MockProvider', () => {
  const p = new MockProvider({
    ticket: { value: { answer: 'cheap' }, confidence: 0.4, fieldConfidence: { answer: 0.4 } },
    fn: (input: unknown) => ({ answer: String((input as { feature: string }).feature) }),
    broken: { nope: true },
  });

  it('returns canned values by schema name with confidence', async () => {
    const r = await p.suggest(prompt, schema, { schemaName: 'ticket' });
    expect(r.ok && [r.value.answer, r.confidence, r.fieldConfidence]).toEqual([
      'cheap',
      0.4,
      { answer: 0.4 },
    ]);
    const f = await p.suggest({ feature: 'abc' }, schema, { schemaName: 'fn' });
    expect(f.ok && f.value.answer).toBe('abc');
  });

  it('validates canned output like a real backend', async () => {
    const r = await p.suggest(prompt, schema, { schemaName: 'broken' });
    expect(!r.ok && r.error.code).toBe('invalid_output');
    const m = await p.suggest(prompt, schema, { schemaName: 'missing' });
    expect(!m.ok && m.error.code).toBe('unsupported');
    const d = await p.suggest(prompt, schema);
    expect(!d.ok && d.error.code).toBe('unsupported');
    expect(p.calls.length).toBeGreaterThan(0);
  });

  it('supports the other capabilities', async () => {
    expect([...p.capabilities()].sort()).toEqual([
      'chat',
      'embed',
      'extract',
      'suggest',
      'transcribe',
    ]);
    const e = await p.embed(['abc', 'abc']);
    expect(e[0]).toEqual(e[1]);
    const text: string[] = [];
    for await (const ev of p.chat([])) if (ev.type === 'text') text.push(ev.delta);
    expect(text.join('').trim()).toBe('mock reply');
    const x = await p.extract({ kind: 'text' }, schema, { schemaName: 'ticket' });
    expect(x.ok).toBe(true);
  });
});

describe('BaseProvider defaults', () => {
  it('reports unsupported capabilities', async () => {
    const b = new (class extends BaseProvider {
      readonly id = 'ollama' as const;
      capabilities() {
        return new Set<Capability>();
      }
    })() as AiProvider;
    expect((await b.suggest(prompt, schema)).ok).toBe(false);
    expect((await b.extract({ kind: 'text' }, schema)).ok).toBe(false);
    expect((await b.transcribe({ bytes: new Uint8Array(), mime: 'x' })).ok).toBe(false);
    await expect(b.embed([])).rejects.toThrow();
    const ev: AiChatEvent[] = [];
    for await (const e of b.chat([])) ev.push(e);
    expect(ev[0]?.type).toBe('error');
  });
});
