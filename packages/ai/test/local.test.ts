import { createServer, type Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AiRouter,
  FixtureOcrEngine,
  GrammarBuilder,
  HashEmbedder,
  HsnVectorIndex,
  HybridHsnLookup,
  InMemoryHsnLookup,
  LocalLlamaProvider,
  MemoryModelStorage,
  ModelError,
  ModelManager,
  MockProvider,
  OllamaProvider,
  RulesProvider,
  binarise,
  boxesFromLines,
  buildHsnVectors,
  bundleFor,
  classify,
  contentBounds,
  cosine,
  deskew,
  detectBrowserHardware,
  draftMessage,
  estimateSkew,
  extractBillFromText,
  extractJson,
  extractPurchaseBill,
  fits,
  gbnf,
  generateStructured,
  keeper,
  layoutText,
  linesOf,
  matchItem,
  matchSupplier,
  nameSimilarity,
  otsu,
  paraphraseKeepsFacts,
  parseDate,
  parseSpeech,
  prepare,
  purchaseBillSchema,
  readNumber,
  rotate,
  signManifest,
  toGrey,
  verifyManifest,
  voiceDraftSchema,
  type FetchedRange,
  type GreyImage,
  type Hardware,
  type ModelEntry,
  type RasterImage,
  type SidecarRuntime,
  type UnsignedManifest,
} from '../src';

const hw = (over: Partial<Hardware> = {}): Hardware => ({
  ramGb: 8,
  cores: 4,
  gpu: 'none',
  os: 'linux',
  arch: 'x64',
  ...over,
});

describe('hardware', () => {
  it('puts the 8 GB laptop in the baseline class, and sizes up with memory or a gpu', () => {
    expect(classify(hw())).toBe('baseline');
    expect(classify(hw({ ramGb: 4 }))).toBe('minimal');
    expect(classify(hw({ ramGb: 16 }))).toBe('capable');
    expect(classify(hw({ ramGb: 12, gpu: 'vulkan' }))).toBe('capable');
    expect(classify(hw({ ramGb: 32, gpu: 'metal' }))).toBe('strong');
    expect(classify(hw({ ramGb: 32 }))).toBe('capable');
  });
  it('says whether a model fits beside the app and the OCR engine', () => {
    expect(fits(hw(), 1.1 * 2 ** 30)).toBe(true); // a 1.5B q4
    expect(fits(hw(), 4.5 * 2 ** 30)).toBe(false); // a 7B q4 on 8 GB
    expect(fits(hw({ ramGb: 16 }), 4.5 * 2 ** 30)).toBe(true);
  });
  it('reads what a browser will say', () => {
    const h = detectBrowserHardware({
      deviceMemory: 8,
      hardwareConcurrency: 8,
      gpu: {},
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(h).toMatchObject({ ramGb: 8, cores: 8, gpu: 'webgpu', os: 'windows', arch: 'x64' });
    expect(
      detectBrowserHardware({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }),
    ).toMatchObject({ os: 'android', ramGb: 4 });
  });
});

async function devKey() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    pub: {
      keyId: 'test-1',
      algorithm: 'ed25519' as const,
      publicKeyBase64: btoa(String.fromCharCode(...pub)),
    },
    priv: { keyId: 'test-1', privateKeyPkcs8: priv },
  };
}

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: 'tiny-llm-q4',
  kind: 'llm',
  name: 'Tiny',
  version: '1',
  file: 'tiny.gguf',
  url: 'https://models.example/tiny.gguf',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  licence: { name: 'Apache-2.0', summary: 'Free to use and redistribute with notice.' },
  minRamGb: 4,
  platforms: [],
  languages: ['en'],
  notes: '',
  ...over,
});

describe('model manifest', () => {
  it('verifies a signed manifest and refuses a changed one', async () => {
    const k = await devKey();
    const unsigned: UnsignedManifest = {
      format: 1,
      generatedAt: '2026-11-07',
      models: [entry()],
      bundles: [{ deviceClass: 'baseline', models: ['tiny-llm-q4'] }],
    };
    const signed = await signManifest(unsigned, k.priv);
    expect((await verifyManifest(signed, k.pub)).ok).toBe(true);
    const tampered = { ...signed, models: [entry({ url: 'https://evil.example/x.gguf' })] };
    expect(await verifyManifest(tampered, k.pub)).toMatchObject({ ok: false, reason: 'signature' });
    expect(await verifyManifest({ ...signed, keyId: 'other' }, k.pub)).toMatchObject({
      ok: false,
      reason: 'key',
    });
    expect(await verifyManifest({ hello: 1 }, k.pub)).toMatchObject({ ok: false, reason: 'shape' });
  });
  it('picks the bundle for the device and drops what will not fit or run here', () => {
    const m = {
      format: 1 as const,
      generatedAt: '',
      keyId: '',
      signature: '',
      models: [
        entry(),
        entry({ id: 'big-llm', minRamGb: 16 }),
        entry({ id: 'llama-win', kind: 'runtime', platforms: ['windows-x64'] }),
      ],
      bundles: [
        { deviceClass: 'baseline' as const, models: ['tiny-llm-q4', 'big-llm', 'llama-win'] },
      ],
    };
    expect(bundleFor(m, 'baseline', { ramGb: 8, platform: 'linux-x64' }).map((e) => e.id)).toEqual([
      'tiny-llm-q4',
    ]);
    expect(
      bundleFor(m, 'baseline', { ramGb: 16, platform: 'windows-x64' }).map((e) => e.id),
    ).toEqual(['tiny-llm-q4', 'big-llm', 'llama-win']);
  });
});

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A server that hands out `file` in chunks and honours Range. */
function fakeServer(
  file: Uint8Array,
  opts: { chunk?: number; ignoreRange?: boolean; failAfter?: number } = {},
) {
  const calls: number[] = [];
  const fetchRange = async (
    _url: string,
    from: number,
    signal: AbortSignal,
  ): Promise<FetchedRange> => {
    calls.push(from);
    const start = opts.ignoreRange ? 0 : from;
    const size = opts.chunk ?? 3;
    let sent = 0;
    async function* body() {
      for (let at = start; at < file.length; at += size) {
        if (signal.aborted) return;
        if (opts.failAfter !== undefined && sent >= opts.failAfter)
          throw new Error('connection reset');
        yield file.slice(at, at + size);
        sent += size;
      }
    }
    return { status: start > 0 ? 206 : 200, totalBytes: file.length, body: body() };
  };
  return { fetchRange, calls };
}

describe('model manager', () => {
  const file = new TextEncoder().encode('0123456789');
  const manifest = async () => ({
    format: 1 as const,
    generatedAt: '',
    keyId: 'k',
    signature: 's',
    models: [entry({ sha256: await sha(file) })],
    bundles: [],
  });

  it('refuses to download before the licence is accepted, then downloads and verifies', async () => {
    const storage = new MemoryModelStorage();
    const srv = fakeServer(file);
    const m = new ModelManager(storage, srv.fetchRange, () => 1000);
    await m.setManifest(await manifest());
    await expect(m.download('tiny-llm-q4')).rejects.toMatchObject({ code: 'licence' });
    await m.acceptLicence('tiny-llm-q4');
    const s = await m.download('tiny-llm-q4');
    expect(s.status).toBe('ready');
    expect(storage.files.has('tiny.gguf')).toBe(true);
    expect(storage.files.has('tiny.gguf.part')).toBe(false);
    expect(await m.diskUsage()).toBe(10);
    expect(m.ready('llm').map((e) => e.id)).toEqual(['tiny-llm-q4']);
  });

  it('resumes from where it stopped with a Range request, and survives a restart', async () => {
    const storage = new MemoryModelStorage();
    const srv = fakeServer(file, { chunk: 2, failAfter: 4 });
    const m = new ModelManager(storage, srv.fetchRange);
    await m.setManifest(await manifest());
    await m.acceptLicence('tiny-llm-q4');
    await expect(m.download('tiny-llm-q4')).rejects.toThrow('connection reset');
    expect(m.get('tiny-llm-q4')).toMatchObject({ status: 'error', bytes: 4 });
    // a new manager over the same disk sees the partial file
    const srv2 = fakeServer(file, { chunk: 2 });
    const m2 = new ModelManager(storage, srv2.fetchRange);
    await m2.setManifest(await manifest());
    expect(m2.get('tiny-llm-q4')).toMatchObject({
      status: 'paused',
      bytes: 4,
      licenceAcceptedAt: expect.any(Number),
    });
    await m2.download('tiny-llm-q4');
    expect(srv2.calls).toEqual([4]);
    expect(m2.get('tiny-llm-q4')?.status).toBe('ready');
    expect(new TextDecoder().decode(storage.bytes('tiny.gguf'))).toBe('0123456789');
  });

  it('pauses on request and keeps the bytes', async () => {
    const storage = new MemoryModelStorage();
    const srv = fakeServer(file, { chunk: 1 });
    const m = new ModelManager(storage, srv.fetchRange);
    await m.setManifest(await manifest());
    await m.acceptLicence('tiny-llm-q4');
    const unsub = m.subscribe(() => {
      if ((m.get('tiny-llm-q4')?.bytes ?? 0) >= 3) m.pause('tiny-llm-q4');
    });
    const s = await m.download('tiny-llm-q4');
    unsub();
    expect(s.status).toBe('paused');
    expect(s.bytes).toBeGreaterThanOrEqual(3);
    expect(s.bytes).toBeLessThan(10);
  });

  it('throws away a file whose checksum is wrong, and starts over when the server ignores the range', async () => {
    const storage = new MemoryModelStorage();
    const m = new ModelManager(
      storage,
      fakeServer(new TextEncoder().encode('0123456789')).fetchRange,
    );
    await m.setManifest({ ...(await manifest()), models: [entry({ sha256: 'b'.repeat(64) })] });
    await m.acceptLicence('tiny-llm-q4');
    await expect(m.download('tiny-llm-q4')).rejects.toMatchObject({ code: 'hash' });
    expect(storage.files.size).toBe(0);
    expect(m.get('tiny-llm-q4')?.status).toBe('error');

    await storage.append('tiny.gguf.part', new TextEncoder().encode('xxxx'));
    const m2 = new ModelManager(storage, fakeServer(file, { ignoreRange: true }).fetchRange);
    await m2.setManifest(await manifest());
    await m2.acceptLicence('tiny-llm-q4');
    expect((await m2.download('tiny-llm-q4')).status).toBe('ready');
  });

  it('refuses when there is no room, and deletes', async () => {
    const storage = new MemoryModelStorage();
    storage.free = 5;
    const m = new ModelManager(storage, fakeServer(file).fetchRange);
    await m.setManifest(await manifest());
    await m.acceptLicence('tiny-llm-q4');
    await expect(m.download('tiny-llm-q4')).rejects.toBeInstanceOf(ModelError);
    storage.free = null;
    await m.download('tiny-llm-q4');
    await m.delete('tiny-llm-q4');
    expect(m.get('tiny-llm-q4')).toMatchObject({ status: 'none', bytes: 0 });
    expect(await m.diskUsage()).toBe(0);
  });
});

describe('grammar from a schema', () => {
  it('writes a GBNF grammar that names every field in order and types the leaves', () => {
    const g = gbnf(purchaseBillSchema);
    expect(g.startsWith('root ::= ws obj')).toBe(true);
    expect(g).toContain('"\\"supplierName\\"" ws ":" ws string');
    expect(g).toContain('"\\"totalPaise\\"" ws ":" ws integer');
    expect(g).toContain('"\\"qty\\"" ws ":" ws number');
    expect(g).toContain('string | null'); // supplierGstin
    expect(g).toContain('ws "," ws'); // commas between fields
    const t = gbnf(voiceDraftSchema);
    expect(t).toContain('"\\"sale\\"" | "\\"purchase\\"" | "\\"payment\\"" | "\\"unknown\\""');
    // the same schema always gives the same grammar
    expect(gbnf(purchaseBillSchema)).toBe(g);
    // every rule referenced is defined
    const defined = new Set(g.split('\n').map((l) => l.split(' ::= ')[0]!));
    for (const ref of g.match(/\b(?:obj|arr|opt|enum|lit|union)\d+\b/g) ?? [])
      expect(defined.has(ref)).toBe(true);
  });
  it('covers enums, literals, unions, records and optionals', () => {
    const b = new GrammarBuilder();
    const g = b.build(
      z.object({
        a: z.literal('x'),
        b: z.union([z.string(), z.number()]),
        c: z.record(z.string(), z.unknown()),
        d: z.number().optional(),
        e: z.boolean(),
      }),
    );
    expect(g).toContain('"\\"x\\""');
    expect(g).toContain('string | number');
    expect(g).toContain('ws ":" ws object');
    expect(g).toContain('number | null');
    expect(g).toContain('ws ":" ws boolean');
  });
  it('pulls JSON out of prose and fences', () => {
    expect(extractJson('Sure! ```json\n{"a": 1, "b": "x}"}\n```')).toEqual({ a: 1, b: 'x}' });
    expect(extractJson('[1,2] trailing')).toEqual([1, 2]);
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{"broken": ')).toBeUndefined();
  });
});

describe('sidecar keeper', () => {
  it('starts on first use, runs one call at a time, and stops after the idle time', async () => {
    const log: string[] = [];
    const runtime: SidecarRuntime = {
      start: async (kind) => {
        log.push(`start ${kind}`);
        return { baseUrl: 'http://127.0.0.1:1' };
      },
      stop: async (kind) => {
        log.push(`stop ${kind}`);
      },
    };
    const timers: { fn: () => void; ms: number }[] = [];
    const k = keeper(
      runtime,
      'llama',
      { modelFile: 'm.gguf', idleMs: 1000 },
      {
        setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
        clearTimeout: () => undefined,
      },
    );
    let running = 0;
    let peak = 0;
    const call = () =>
      k.withServer(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return 'ok';
      });
    expect(await Promise.all([call(), call(), call()])).toEqual(['ok', 'ok', 'ok']);
    expect(peak).toBe(1);
    expect(log).toEqual(['start llama']);
    expect(k.running()).toBe(true);
    timers[timers.length - 1]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['start llama', 'stop llama']);
    expect(k.running()).toBe(false);
  });
  it('a failing call does not block the next one', async () => {
    const runtime: SidecarRuntime = {
      start: async () => ({ baseUrl: 'x' }),
      stop: async () => undefined,
    };
    const k = keeper(
      runtime,
      'llama',
      { modelFile: 'm' },
      { setTimeout: () => 0, clearTimeout: () => undefined },
    );
    await expect(
      k.withServer(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await k.withServer(async () => 1)).toBe(1);
  });
});

describe('structured generation', () => {
  it('turns rupee answers into paise and validates against the caller schema', async () => {
    const r = await generateStructured({
      generate: async (messages, c) => {
        expect(messages[0]!.role).toBe('system');
        expect(c.grammar).toContain('root ::=');
        return {
          text: 'Here you go: {"supplierName":"ACME","supplierGstin":null,"invoiceNumber":"A1","date":"2026-04-01","lines":[{"description":"Pen","hsn":"9608","qty":2,"rate":10.5,"gstRate":18}],"total":24.78}',
        };
      },
      provider: 'local-llama',
      model: 'tiny',
      schema: purchaseBillSchema,
      name: 'purchaseBill',
      text: 'bill',
    });
    expect(r.ok && r.value.lines[0]!.ratePaise).toBe(1050);
    expect(r.ok && r.value.totalPaise).toBe(2478);
    expect(r.ok && r.value.lines[0]!.gstRateBp).toBe(1800);
  });
  it('fails closed on no JSON, a wrong shape, or an unknown prompt', async () => {
    const bad = await generateStructured({
      generate: async () => ({ text: 'I cannot' }),
      provider: 'p',
      model: 'm',
      schema: purchaseBillSchema,
      name: 'purchaseBill',
      text: 'x',
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    const shape = await generateStructured({
      generate: async () => ({ text: '{"supplierName": 5}' }),
      provider: 'p',
      model: 'm',
      schema: purchaseBillSchema,
      name: 'purchaseBill',
      text: 'x',
    });
    expect(shape).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    const none = await generateStructured({
      generate: async () => ({ text: '{}' }),
      provider: 'p',
      model: 'm',
      schema: z.object({}),
      name: 'nothing',
      text: 'x',
    });
    expect(none).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});

/** A llama.cpp-shaped server: `/health`, `/v1/chat/completions` (answers from the grammar's presence), `/v1/embeddings`. */
function fakeLlamaServer(): Promise<{ server: Server; url: string; seen: unknown[] }> {
  const seen: unknown[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/health') return res.end('{"status":"ok"}');
        const j = body ? JSON.parse(body) : {};
        seen.push({ url: req.url, body: j });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/chat/completions') {
          const hasGrammar = typeof j.grammar === 'string' && j.grammar.includes('root ::=');
          const content = hasGrammar
            ? '{"supplierName":"Fake Traders","supplierGstin":"27AAPFU0939F1ZV","invoiceNumber":"F-9","date":"2026-05-02","lines":[{"description":"Widget","hsn":"8471","qty":3,"rate":100,"gstRate":18}],"total":354}'
            : 'no grammar, no json';
          return res.end(
            JSON.stringify({
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 50, completion_tokens: 40 },
            }),
          );
        }
        if (req.url === '/v1/embeddings') {
          const inputs: string[] = j.input;
          return res.end(
            JSON.stringify({
              data: inputs.map((t, index) => ({ index, embedding: [t.length, 1, 0] })),
            }),
          );
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${a.port}`, seen });
    });
  });
}

describe('local llama provider over the sidecar protocol', () => {
  it('starts the server, sends the grammar, parses the answer, embeds, and stops when idle', async () => {
    const fake = await fakeLlamaServer();
    try {
      const started: string[] = [];
      const runtime: SidecarRuntime = {
        start: async (kind, a) => {
          started.push(`${kind}:${a.modelFile}`);
          return { baseUrl: fake.url };
        },
        stop: async () => {
          started.push('stop');
        },
      };
      const timers: (() => void)[] = [];
      const llm = keeper(
        runtime,
        'llama',
        { modelFile: 'tiny.gguf', idleMs: 10 },
        { setTimeout: (fn) => (timers.push(fn), 1), clearTimeout: () => undefined },
      );
      const p = new LocalLlamaProvider({ llm, modelName: 'tiny' });
      const r = await p.extract({ kind: 'text', text: 'FAKE TRADERS ...' }, purchaseBillSchema, {
        schemaName: 'purchaseBill',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.supplierName).toBe('Fake Traders');
        expect(r.value.lines[0]!.ratePaise).toBe(10000);
        expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 40 });
      }
      expect(started).toEqual(['llama:tiny.gguf']);
      const sent = fake.seen[0] as { body: { grammar: string; messages: { role: string }[] } };
      expect(sent.body.grammar).toContain('"\\"supplierName\\""');
      expect(sent.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
      const vecs = await p.embed(['ab', 'abcd']);
      expect([...vecs[1]!]).toEqual([4, 1, 0]);
      timers[timers.length - 1]!();
      await new Promise((r) => setTimeout(r, 5));
      expect(started.at(-1)).toBe('stop');
      // a text-less document is refused so the router can fall through
      expect(
        await p.extract({ kind: 'image' }, purchaseBillSchema, { schemaName: 'purchaseBill' }),
      ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    } finally {
      fake.server.close();
    }
  });

  it('through the router, falls back to rules when the server is down', async () => {
    const runtime: SidecarRuntime = {
      start: async () => {
        throw new Error('no binary');
      },
      stop: async () => undefined,
    };
    const llm = keeper(
      runtime,
      'llama',
      { modelFile: 'x' },
      { setTimeout: () => 0, clearTimeout: () => undefined },
    );
    const rules = new RulesProvider();
    rules.registerRule('voice_draft', async (input) => ({
      value: parseSpeech(String(input?.text ?? '')),
      confidence: 0.5,
    }));
    const router = new AiRouter({
      settings: { tier0: true, tier1: 'local-llama', tier2: null, askBeforeCloud: true },
      providers: [new LocalLlamaProvider({ llm, modelName: 'tiny' }), rules],
      hardware: { ramGb: 8, cores: 4 },
    });
    const r = await router.suggest(
      { feature: 'voice_draft', input: { text: '2 kg sugar 40 rupees' } },
      voiceDraftSchema,
      { schemaName: 'voiceDraft' },
    );
    expect(r.ok && r.provider).toBe('rules');
    const hw4 = new AiRouter({
      settings: { tier0: true, tier1: 'local-llama', tier2: null, askBeforeCloud: true },
      providers: [new LocalLlamaProvider({ llm, modelName: 'tiny' }), rules],
      hardware: { ramGb: 4, cores: 2 },
    });
    expect(hw4.plan('suggest').map((p) => p.id)).toEqual(['rules']);
  });
});

describe('ollama provider', () => {
  it('asks /api/chat with the json schema as format, and /api/embed for vectors', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith('/api/tags'))
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] }));
      if (url.endsWith('/api/chat'))
        return new Response(
          JSON.stringify({
            message: { content: '{"text":"Namaste Ramesh ji, Rs 1,200 due on 05-06-2026."}' },
            prompt_eval_count: 9,
            eval_count: 7,
          }),
        );
      if (url.endsWith('/api/embed'))
        return new Response(JSON.stringify({ embeddings: body.input.map(() => [0.1, 0.2]) }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider({ model: 'qwen2.5:1.5b', fetchFn });
    expect(await p.models()).toEqual(['qwen2.5:1.5b']);
    const r = await p.suggest(
      {
        feature: 'paraphrase',
        text: 'Hello Ramesh, Rs 1,200 is due on 05-06-2026.',
        input: { language: 'hi' },
      },
      z.object({ text: z.string() }),
      { schemaName: 'paraphrase' },
    );
    expect(r.ok && r.value.text).toContain('1,200');
    expect(calls[1]!.body.format.type).toBe('object');
    expect(calls[1]!.body.stream).toBe(false);
    expect((await p.embed(['a', 'b'])).length).toBe(2);
  });
});

/** A white page with dark "text lines" (rectangles), optionally tilted. */
function page(width: number, height: number, tilt = 0): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rad = (tilt * Math.PI) / 180;
  for (let row = 0; row < 12; row++) {
    const y0 = 60 + row * 30;
    for (let x = 40; x < width - 40; x++) {
      if (x % 60 > 45) continue; // word gaps
      for (let dy = 0; dy < 10; dy++) {
        const y = Math.round(y0 + dy + (x - width / 2) * Math.tan(rad));
        if (y >= 0 && y < height) {
          const p = (y * width + x) * 4;
          data[p] = data[p + 1] = data[p + 2] = 20;
        }
      }
    }
  }
  return { width, height, data };
}

describe('OCR preprocessing', () => {
  it('finds the threshold between ink and paper', () => {
    const g = toGrey(page(300, 460));
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(20);
    expect(t).toBeLessThan(255);
    const b = binarise(g, t);
    expect(new Set(b.data)).toEqual(new Set([0, 255]));
  });
  it('estimates the tilt of a page and straightens it', () => {
    const tilted = toGrey(page(400, 500, 3));
    const angle = estimateSkew(tilted);
    expect(Math.abs(angle - 3)).toBeLessThanOrEqual(0.6);
    const { image, angle: a2 } = deskew(tilted);
    expect(a2).toBe(angle);
    expect(Math.abs(estimateSkew(image))).toBeLessThanOrEqual(0.6);
    expect(estimateSkew(toGrey(page(400, 500, 0)))).toBe(0);
  });
  it('crops to the printed area and keeps a margin', () => {
    const img = page(300, 460);
    const box = contentBounds(binarise(toGrey(img)));
    expect(box.x).toBeGreaterThanOrEqual(20);
    expect(box.x).toBeLessThanOrEqual(40);
    expect(box.y).toBeGreaterThanOrEqual(40);
    expect(box.y).toBeLessThanOrEqual(60);
    expect(box.w).toBeLessThan(300);
    const out = prepare(img);
    expect(out.image.width).toBe(box.w);
    expect(out.angle).toBe(0);
  });
  it('rotation keeps the size and fills the corners with paper', () => {
    const g: GreyImage = { width: 20, height: 20, data: new Uint8ClampedArray(400).fill(0) };
    const r = rotate(g, 45);
    expect(r.width).toBe(20);
    expect(r.data[0]).toBe(255);
    expect(r.data[10 * 20 + 10]).toBe(0);
  });
});

describe('layout', () => {
  it('joins words on a row, keeps column gaps, and orders rows top to bottom', () => {
    const r = boxesFromLines(['Cement 50kg  10  350  3500', 'Total  3500']);
    const lines = linesOf(r.boxes);
    expect(lines.map((l) => l.text)).toEqual(['Cement 50kg  10  350  3500', 'Total  3500']);
    expect(layoutText({ boxes: [...r.boxes].reverse() })).toBe(
      'Cement 50kg  10  350  3500\nTotal  3500',
    );
  });
});

const BILL_A = `SHREE GANESH TRADERS
12, Market Road, Pune 411001
GSTIN: 27AAPFU0939F1ZV   Phone: 9876543210
TAX INVOICE
Invoice No: SGT/2026/0412        Date: 15/06/2026
Bill To: Our Shop, GSTIN 27AABCU9603R1ZX
S.No  Description          HSN   Qty   Rate     Amount
1     Cement OPC 53 50kg   2523  20    380.00   7600.00
2     TMT Bar 12mm         7214  100   62.50    6250.00
Sub Total                                       13850.00
CGST 9%                                         1246.50
SGST 9%                                         1246.50
Grand Total                                     16343.00
Rupees Sixteen Thousand Three Hundred Forty Three Only
E.&O.E.   Authorised Signatory`;

const BILL_B = `Kumar Electricals
Invoice No. KE-77 dt 02-04-2026
GST No 33AAACK1234K1Z5
Wire 1.5 sqmm 90m   2   1250   2500
Switch 6A           10  45     450
IGST 18%   531
Total 3481`;

describe('rules extraction', () => {
  it('reads a printed invoice with a header row', () => {
    const r = extractBillFromText(BILL_A, { ownGstin: '27AABCU9603R1ZX' });
    expect(r.bill.supplierName).toBe('SHREE GANESH TRADERS');
    expect(r.bill.supplierGstin).toBe('27AAPFU0939F1ZV');
    expect(r.bill.invoiceNumber).toBe('SGT/2026/0412');
    expect(r.bill.date).toBe('2026-06-15');
    expect(r.bill.lines).toEqual([
      {
        description: 'Cement OPC 53 50kg',
        hsn: '2523',
        qty: 20,
        ratePaise: 38000,
        gstRateBp: 1800,
      },
      { description: 'TMT Bar 12mm', hsn: '7214', qty: 100, ratePaise: 6250, gstRateBp: 1800 },
    ]);
    expect(r.bill.totalPaise).toBe(1634300);
    expect(r.fieldConfidence['supplierGstin']).toBeGreaterThanOrEqual(0.9);
    expect(r.fieldConfidence['totalPaise']).toBeGreaterThanOrEqual(0.85);
    expect(r.lineRows).toEqual([7, 8]);
  });
  it('reads a bill with no header row and a date after "dt"', () => {
    const r = extractBillFromText(BILL_B);
    expect(r.bill.supplierName).toBe('Kumar Electricals');
    expect(r.bill.invoiceNumber).toBe('KE-77');
    expect(r.bill.date).toBe('2026-04-02');
    expect(r.bill.lines.map((l) => [l.description, l.qty, l.ratePaise, l.gstRateBp])).toEqual([
      ['Wire 1.5 sqmm 90m', 2, 125000, 1800],
      ['Switch 6A', 10, 4500, 1800],
    ]);
    expect(r.bill.totalPaise).toBe(348100);
  });
  it('parses the date spellings bills use', () => {
    expect(parseDate('Date: 5/6/26')).toBe('2026-06-05');
    expect(parseDate('Dated 05-06-2026')).toBe('2026-06-05');
    expect(parseDate('5th June 2026')).toBe('2026-06-05');
    expect(parseDate('2026-06-05')).toBe('2026-06-05');
    expect(parseDate('31/13/2026')).toBeNull();
  });
  it('is honest about what it could not find', () => {
    const r = extractBillFromText('just some words');
    expect(r.fieldConfidence['invoiceNumber']).toBeLessThan(0.3);
    expect(r.bill.lines).toEqual([]);
  });
});

describe('matching', () => {
  const parties = [
    { id: 'p1', name: 'Shree Ganesh Traders Pvt Ltd', gstin: '27AAPFU0939F1ZV' },
    { id: 'p2', name: 'Kumar Electricals', gstin: null },
    { id: 'p3', name: 'Kumar Electronics', gstin: null },
  ];
  it('matches a supplier by GSTIN first, then by name', () => {
    expect(
      matchSupplier({ supplierName: 'Someone', supplierGstin: '27aapfu0939f1zv' }, parties),
    ).toMatchObject({ partyId: 'p1', by: 'gstin', score: 1 });
    expect(
      matchSupplier({ supplierName: 'KUMAR ELECTRICALS', supplierGstin: null }, parties),
    ).toMatchObject({ partyId: 'p2', by: 'name' });
    expect(
      matchSupplier({ supplierName: 'M/s Shree Ganesh Traders', supplierGstin: null }, parties)
        .partyId,
    ).toBe('p1');
    expect(
      matchSupplier({ supplierName: 'Totally New Co', supplierGstin: null }, parties),
    ).toMatchObject({ partyId: null, by: 'none' });
    expect(nameSimilarity('Kumar Electricals', 'Kumar Electronics')).toBeLessThan(1);
  });
  it('matches items by name with HSN and rate as tie-breakers', () => {
    const items = [
      {
        id: 'i1',
        name: 'Cement OPC 53 Grade 50kg',
        hsn: '2523',
        purchaseRatePaise: 38000,
        gstRateBp: 2800,
      },
      { id: 'i2', name: 'Cement PPC 50kg', hsn: '2523', purchaseRatePaise: 36000, gstRateBp: 2800 },
      {
        id: 'i3',
        name: 'Paint Brush 2 inch',
        hsn: '9603',
        purchaseRatePaise: 2500,
        gstRateBp: 1800,
      },
    ];
    expect(
      matchItem(
        { description: 'Cement OPC 53 50kg', hsn: '2523', ratePaise: 38000, gstRateBp: 2800 },
        items,
      ).itemId,
    ).toBe('i1');
    expect(
      matchItem({ description: 'Brush 2"', hsn: null, ratePaise: 0, gstRateBp: 0 }, items).itemId,
    ).toBeNull();
    expect(
      matchItem({ description: 'Paint Brush 2in', hsn: null, ratePaise: 2500, gstRateBp: 0 }, items)
        .itemId,
    ).toBe('i3');
  });
});

describe('the extraction pipeline', () => {
  const opts = {
    parties: [{ id: 'p1', name: 'Shree Ganesh Traders', gstin: '27AAPFU0939F1ZV' }],
    items: [
      {
        id: 'i1',
        name: 'Cement OPC 53 50kg',
        hsn: '2523',
        purchaseRatePaise: 38000,
        gstRateBp: 1800,
      },
    ],
    ownGstin: '27AABCU9603R1ZX',
    businessState: '27',
    today: '2026-11-07',
  };
  it('runs OCR, rules, matching and the engine check from an image', async () => {
    const ocr = new FixtureOcrEngine(() => BILL_A.split('\n'));
    const steps: string[] = [];
    const r = await extractPurchaseBill(
      { kind: 'image', image: page(1000, 500) },
      { ...opts, ocr, onStep: (s) => steps.push(s) },
    );
    expect(steps).toEqual(['prepare', 'ocr', 'rules', 'match', 'check']);
    expect(r.bill.invoiceNumber).toBe('SGT/2026/0412');
    expect(r.supplier).toMatchObject({ partyId: 'p1', by: 'gstin' });
    expect(r.lineMatches[0]!.itemId).toBe('i1');
    expect(r.lineMatches[1]!.itemId).toBeNull();
    expect(r.checks.engineTotalPaise).toBe(1634300);
    expect(r.checks.totalsAgree).toBe(true);
    expect(r.checks.gstinValid).toBe(true);
    expect(r.checks.dateSane).toBe(true);
    expect(r.ocr?.engine).toBe('fixture');
    expect(r.sources).toEqual(['rules']);
    expect(r.confidence).toBeGreaterThan(0.7);
  });
  it('flags a total the engine cannot reproduce and a date in the future', async () => {
    const text = BILL_A.replace('16343.00', '16999.00').replace('15/06/2026', '15/06/2027');
    const r = await extractPurchaseBill({ kind: 'text', text }, opts);
    expect(r.checks.totalsAgree).toBe(false);
    expect(r.fieldConfidence['totalPaise']).toBeLessThanOrEqual(0.45);
    expect(r.checks.dateSane).toBe(false);
    expect(r.fieldConfidence['date']).toBeLessThanOrEqual(0.4);
  });
  it('merges a model answer with the rules: agreement lifts confidence, disagreement lowers it', async () => {
    const rulesOnly = extractBillFromText(BILL_A, { ownGstin: opts.ownGstin });
    const modelSays = {
      ...rulesOnly.bill,
      supplierName: 'Shree Ganesh Traders',
      invoiceNumber: 'WRONG-1',
    };
    const mock = new MockProvider({ purchaseBill: modelSays });
    const router = new AiRouter({
      settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
      providers: [mock],
    });
    const r = await extractPurchaseBill({ kind: 'text', text: BILL_A }, { ...opts, router });
    expect(r.sources).toEqual(['rules', 'mock']);
    expect(r.bill.date).toBe('2026-06-15');
    expect(r.fieldConfidence['date']).toBeGreaterThan(rulesOnly.fieldConfidence['date']!);
    // rules were sure of the invoice number, so the model's different answer is set aside and flagged
    expect(r.bill.invoiceNumber).toBe('SGT/2026/0412');
    expect(r.fieldConfidence['invoiceNumber']).toBeLessThan(
      rulesOnly.fieldConfidence['invoiceNumber']!,
    );
    // the name was a weak guess, so the model's cleaner one wins
    expect(r.bill.supplierName).toBe('Shree Ganesh Traders');
  });
});

describe('speech to a draft', () => {
  it('reads numbers in words across languages', () => {
    const n = (s: string) =>
      readNumber(
        s.split(' ').map((raw) => ({ raw, lower: raw.toLowerCase() })),
        0,
      )?.value;
    expect(n('teen sau pachas')).toBe(350);
    expect(n('do hazaar paanch sau')).toBe(2500);
    expect(n('twenty five')).toBe(25);
    expect(n('adha')).toBe(0.5);
    expect(n('dedh')).toBeUndefined();
    expect(n('aimbathu')).toBe(50);
    expect(n('पाँच सौ')).toBe(500);
    expect(n('1,250')).toBeUndefined();
    expect(n('12.5 kilo')).toBe(12.5);
  });
  it('turns sentences into party, lines and prices', () => {
    const a = parseSpeech(
      'Ramesh ko do bori cement teen sau pachas rupaye aur paanch kilo nails sau rupaye ka bill banao',
    );
    expect(a.party).toBe('Ramesh');
    expect(a.intent).toBe('sale');
    expect(a.lines).toEqual([
      { description: 'cement', qty: 2, unit: 'BAG', ratePaise: 35000 },
      { description: 'nails', qty: 5, unit: 'KGS', ratePaise: 10000 },
    ]);
    const b = parseSpeech('3 kg sugar at 42 and 2 litre oil 180 rupees for Sharma Stores');
    expect(b.party).toBe('Sharma Stores');
    expect(b.lines).toEqual([
      { description: 'sugar', qty: 3, unit: 'KGS', ratePaise: 4200 },
      { description: 'oil', qty: 2, unit: 'LTR', ratePaise: 18000 },
    ]);
    const c = parseSpeech('Gupta ji se 10 peti biscuit kharida 500 rupaye wala');
    expect(c.intent).toBe('purchase');
    expect(c.party).toBe('Gupta');
    expect(c.lines[0]).toMatchObject({
      description: 'biscuit',
      qty: 10,
      unit: 'BOX',
      ratePaise: 50000,
    });
    const d = parseSpeech('Kannan kku irandu kilo arisi aimbathu rupaai');
    expect(d.party).toBe('Kannan');
    expect(d.lines[0]).toMatchObject({ qty: 2, unit: 'KGS', description: 'arisi' });
    const e = parseSpeech('Patil kadun paach kilo sakhar');
    expect(e.lines[0]).toMatchObject({ description: 'sakhar', qty: 5, unit: 'KGS' });
    const f = parseSpeech('Mehta ko 2000 rupaye payment mila');
    expect(f.intent).toBe('payment');
    expect(f.amountPaise).toBe(200000);
    expect(f.lines).toEqual([]);
    expect(parseSpeech('').confidence).toBe(0);
    expect(voiceDraftSchema.safeParse(a).success).toBe(true);
  });
});

describe('regional drafting', () => {
  it('fills the template and keeps the rephrasing only when every fact survived', async () => {
    const template = 'Namaste {{name}}, Rs {{amount}} is due on {{date}}.';
    const vars = { name: 'Ramesh', amount: '1,200', date: '05-06-2026' };
    const plain = await draftMessage({ template, vars, language: 'hi' });
    expect(plain).toEqual({
      text: 'Namaste Ramesh, Rs 1,200 is due on 05-06-2026.',
      paraphrased: false,
      provider: null,
    });
    const good = new MockProvider({
      paraphrase: {
        text: 'Ramesh ji, namaste. Aapka Rs 1,200 ka bhugtaan 05-06-2026 tak dena hai.',
      },
    });
    const router = (p: MockProvider) =>
      new AiRouter({
        settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
        providers: [p],
      });
    const r = await draftMessage({
      template,
      vars,
      language: 'hi',
      router: router(good),
      mustKeep: ['Ramesh'],
    });
    expect(r.paraphrased).toBe(true);
    const bad = new MockProvider({ paraphrase: { text: 'Ramesh ji, Rs 1,500 is due tomorrow.' } });
    const r2 = await draftMessage({ template, vars, language: 'hi', router: router(bad) });
    expect(r2).toMatchObject({ paraphrased: false, text: plain.text });
    expect(paraphraseKeepsFacts('Pay 500 by 1/2', 'Pay 500 by 1/2 please')).toBe(true);
    expect(paraphraseKeepsFacts('Pay 500 by 1/2', '')).toBe(false);
    expect(paraphraseKeepsFacts('Short', 'x'.repeat(200))).toBe(false);
  });
});

describe('embeddings and the hybrid HSN lookup', () => {
  const entries = [
    { code: '8517', description: 'Telephones, including mobile phones; chargers', rate_bp: 1800 },
    { code: '2523', description: 'Portland cement, aluminous cement, slag cement', rate_bp: 2800 },
    {
      code: '9608',
      description: 'Ball point pens; felt tipped pens; fountain pens',
      rate_bp: 1800,
    },
    { code: '1701', description: 'Cane or beet sugar and chemically pure sucrose', rate_bp: 500 },
  ];
  it('hashed trigram vectors forgive a misspelling, and cosine behaves', async () => {
    const e = new HashEmbedder(128);
    const [a, b, c] = await e.embed(['mobile charger', 'mobil chrger', 'portland cement']);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
  });
  it('merges BM25 and vector scores so a misspelt query still finds its code', async () => {
    const embedder = new HashEmbedder(128);
    const index = new HsnVectorIndex(await buildHsnVectors(entries, embedder, 2));
    const bm25 = new InMemoryHsnLookup(entries);
    const hybrid = new HybridHsnLookup(bm25, index, embedder);
    expect((await bm25.search('mobil chrger', 3))[0]?.code).not.toBe('8517');
    expect((await hybrid.search('mobil chrger', 3))[0]?.code).toBe('8517');
    expect((await hybrid.search('cement', 3))[0]?.code).toBe('2523');
    const out = await hybrid.search('sugar', 2);
    expect(out[0]?.code).toBe('1701');
    expect(out.length).toBe(2);
    for (const h of out) expect(h.score).toBeGreaterThanOrEqual(0);
    vi.restoreAllMocks();
  });
});
