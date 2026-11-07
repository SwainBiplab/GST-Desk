/**
 * The Anthropic provider with the SDK's HTTP mocked (prompt 48): structured output checked against the schema,
 * redaction before the text leaves and after it comes back, the cached prefix (identical bytes, non-zero
 * cache reads on the second call), refusals, schema failures, rate limits, strict tools without forced tool
 * choice, citations, the batch path, and the corpus search.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AnthropicProvider,
  CorpusSearch,
  chunkMarkdown,
  mismatchExplanationSchema,
  parseCorpusFile,
  purchaseBillSchema,
  strictJsonSchema,
  type AiChatEvent,
} from '../src';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Block =
  | { type: 'text'; text: string; citations?: unknown[] }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface Canned {
  content: Block[];
  stop_reason?: string;
  stop_details?: unknown;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
  model?: string;
}

/** The SSE a streamed `/v1/messages` answers with, for a canned message. */
function sse(c: Canned): string {
  const usage = {
    input_tokens: 500,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...c.usage,
  };
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: c.model ?? 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { ...usage, output_tokens: 0 },
    },
  });
  c.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '', citations: b.citations ? [] : null },
      });
      for (const piece of b.text.match(/.{1,40}/gs) ?? [''])
        out += ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: piece },
        });
      for (const citation of b.citations ?? [])
        out += ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'citations_delta', citation },
        });
    } else {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      out += ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index });
  });
  out += ev('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: c.stop_reason ?? 'end_turn',
      stop_sequence: null,
      stop_details: c.stop_details ?? null,
    },
    usage: { ...usage, output_tokens: c.usage?.output_tokens ?? 40 },
    context_management: null,
  });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

/** A fake Anthropic API: canned answers in order, every request recorded. */
function fakeApi(answers: (Canned | { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  let n = 0;
  const batches: Record<string, unknown> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const raw = init?.body ? String(init.body) : '';
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    // the batch surface
    if (url.endsWith('/v1/messages/batches') && init?.method === 'POST') {
      batches['batch_1'] = body;
      return new Response(
        JSON.stringify({
          id: 'batch_1',
          type: 'message_batch',
          processing_status: 'in_progress',
          request_counts: {
            processing: body.requests.length,
            succeeded: 0,
            errored: 0,
            expired: 0,
            canceled: 0,
          },
          ended_at: null,
          created_at: '2026-11-07T00:00:00Z',
          expires_at: '2026-11-08T00:00:00Z',
          archived_at: null,
          cancel_initiated_at: null,
          results_url: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/v1\/messages\/batches\/batch_1$/.test(url))
      return new Response(
        JSON.stringify({
          id: 'batch_1',
          type: 'message_batch',
          processing_status: 'ended',
          request_counts: { processing: 0, succeeded: 2, errored: 0, expired: 0, canceled: 0 },
          ended_at: '2026-11-07T01:00:00Z',
          created_at: '2026-11-07T00:00:00Z',
          expires_at: '2026-11-08T00:00:00Z',
          archived_at: null,
          cancel_initiated_at: null,
          results_url: 'https://api.anthropic.com/v1/messages/batches/batch_1/results',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (/\/v1\/messages\/batches\/batch_1\/results$/.test(url)) {
      const line = (custom_id: string, text: string) =>
        JSON.stringify({
          custom_id,
          result: {
            type: 'succeeded',
            message: {
              id: `msg_${custom_id}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-5-5',
              content: [{ type: 'text', text }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 200 },
            },
          },
        });
      return new Response(
        `${line('b', JSON.stringify({ category: 'rent', partyName: 'Mehta Estates', confidence: 0.9 }))}\n${line('a', JSON.stringify({ category: 'nope' }))}\n`,
        { status: 200, headers: { 'content-type': 'application/x-jsonl' } },
      );
    }
    const a = answers[n++];
    if (!a)
      return new Response(
        JSON.stringify({ error: { type: 'test', message: 'no answer canned' } }),
        { status: 500 },
      );
    if ('status' in a)
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    return new Response(sse(a), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fetchFn, batches };
}

const bill = {
  supplierName: 'Sharma Traders',
  supplierGstin: '27AAPFU0939F1ZV',
  invoiceNumber: 'SH/25-26/0042',
  date: '2025-08-14',
  lines: [
    { description: 'Copper wire 2.5mm', hsn: '7408', qty: 10, ratePaise: 95000, gstRateBp: 1800 },
  ],
  totalPaise: 1121000,
};
const provider = (api: ReturnType<typeof fakeApi>, extra: Record<string, unknown> = {}) =>
  new AnthropicProvider({
    apiKey: 'sk-ant-test',
    fetch: api.fetch,
    maxRetries: 0,
    context: { profile: 'Asha Traders, GSTIN 27AABCD1234E1Z8, Maharashtra, regular scheme' },
    ...extra,
  });

describe('AnthropicProvider: extraction', () => {
  it('asks for structured output, caches the stable prefix, opts into fallbacks, never forces a tool, and masks a PAN', async () => {
    const api = fakeApi([
      {
        content: [{ type: 'text', text: JSON.stringify(bill) }],
        usage: { cache_creation_input_tokens: 900 },
      },
      {
        content: [{ type: 'text', text: JSON.stringify(bill) }],
        usage: { cache_read_input_tokens: 900 },
      },
    ]);
    const p = provider(api);
    const text =
      'TAX INVOICE SH/25-26/0042 Sharma Traders PAN AAPFU0939F dated 2025-08-14 ... total 11,210.00';
    const r1 = await p.extract({ kind: 'text', text }, purchaseBillSchema, {
      feature: 'bill_extract',
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.supplierGstin).toBe('27AAPFU0939F1ZV');
    expect(r1.model).toBe('claude-opus-5-5');
    expect(r1.usage).toMatchObject({ inputTokens: 500, outputTokens: 40, cacheWriteTokens: 900 });

    const req = api.calls[0]!;
    expect(req.url).toContain('/v1/messages');
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.fallbacks).toBe('default');
    expect(req.body.stream).toBe(true);
    expect(req.body.tool_choice).toBeUndefined();
    expect(req.body.thinking).toBeUndefined();
    expect(req.body.output_config.format.type).toBe('json_schema');
    expect(req.body.output_config.format.schema.properties.supplierName).toBeDefined();
    // the system prefix: route text, then the business, the last block cached
    expect(req.body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(req.body.system.at(-1).text).toContain('Asha Traders');
    // the PAN left masked; the GSTIN (which contains it, but is no PAN on its own) stayed
    const sent = JSON.stringify(req.body.messages);
    expect(sent).not.toContain('PAN AAPFU0939F');
    expect(sent).toContain('[PAN_1]');

    // the second call hits the cache: the same prefix bytes, non-zero cache reads
    const r2 = await p.extract({ kind: 'text', text }, purchaseBillSchema, {
      feature: 'bill_extract',
    });
    expect(r2.ok && r2.usage?.cacheReadTokens).toBe(900);
    expect(JSON.stringify(api.calls[1]!.body.system)).toBe(JSON.stringify(req.body.system));
  });

  it('sends an image or a PDF as a block, and the per-route model and effort', async () => {
    const api = fakeApi([
      { content: [{ type: 'text', text: JSON.stringify(bill) }], model: 'claude-sonnet-5-5' },
      { content: [{ type: 'text', text: JSON.stringify(bill) }] },
    ]);
    const p = provider(api, {
      routes: { bill_extract: { model: 'claude-sonnet-5-5', effort: 'high' } },
    });
    const img = await p.extract(
      { kind: 'image', bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' },
      purchaseBillSchema,
      { feature: 'bill_extract' },
    );
    expect(img.ok && img.model).toBe('claude-sonnet-5-5');
    expect(api.calls[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(api.calls[0]!.body.output_config.effort).toBe('high');
    expect(api.calls[0]!.body.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    await p.extract(
      { kind: 'pdf', bytes: new Uint8Array([37, 80, 68, 70]), name: 'notice.pdf' },
      purchaseBillSchema,
      {
        feature: 'summarise_notice',
      },
    );
    expect(api.calls[1]!.body.model).toBe('claude-opus-5-5');
    expect(api.calls[1]!.body.messages[0].content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
      title: 'notice.pdf',
    });
  });

  it('an answer that fails the schema is invalid_output, never a half-valid value', async () => {
    const api = fakeApi([
      { content: [{ type: 'text', text: JSON.stringify({ ...bill, totalPaise: 'eleven' }) }] },
      { content: [{ type: 'text', text: 'not json at all' }] },
    ]);
    const p = provider(api);
    const r = await p.extract({ kind: 'text', text: 'x' }, purchaseBillSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_output');
    const r2 = await p.extract({ kind: 'text', text: 'x' }, purchaseBillSchema);
    expect(!r2.ok && r2.error.code).toBe('invalid_output');
  });

  it('a refusal is ok: false with a plain message, so the next tier answers', async () => {
    const api = fakeApi([
      {
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      },
    ]);
    const r = await provider(api).extract({ kind: 'text', text: 'x' }, purchaseBillSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('refused');
      expect(r.error.message).toContain('declined');
      expect(r.error.message).toContain('cyber');
    }
  });

  it('a rate limit is unavailable and retriable; a bad key is not retriable', async () => {
    const api = fakeApi([
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      },
      {
        status: 401,
        body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      },
    ]);
    const p = provider(api);
    const r = await p.extract({ kind: 'text', text: 'x' }, purchaseBillSchema);
    expect(!r.ok && r.error).toMatchObject({ code: 'unavailable', retriable: true });
    const r2 = await p.extract({ kind: 'text', text: 'x' }, purchaseBillSchema);
    expect(!r2.ok && r2.error).toMatchObject({ code: 'unavailable', retriable: false });
  });

  it('suggest: the mismatch explainer gets the two sides and answers in the schema', async () => {
    const api = fakeApi([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              explanation: 'The supplier reported it under the next month.',
              likelyCause: 'wrong_period',
              suggestedAction: 'Defer the credit to the next month.',
              confidence: 0.8,
            }),
          },
        ],
      },
    ]);
    const r = await provider(api).suggest(
      { feature: 'explain_2b_mismatch', input: { bill: { number: 'B-1' }, entry: null } },
      mismatchExplanationSchema,
    );
    expect(r.ok && r.value.likelyCause).toBe('wrong_period');
    expect(api.calls[0]!.body.messages[0].content).toContain('"B-1"');
    expect(api.calls[0]!.body.system[0].text).toContain('GSTR-2B');
  });
});

describe('AnthropicProvider: tools, citations and batches', () => {
  it('declares strict tools, never forces a call, streams text, and answers a tool call in the next turn', async () => {
    const api = fakeApi([
      {
        content: [
          { type: 'text', text: 'Let me look.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'party_outstanding',
            input: { asOf: '2026-11-07' },
          },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Three parties owe you Rs 12,000.' }] },
    ]);
    const p = provider(api);
    const tools = [
      {
        name: 'party_outstanding',
        description: 'Who owes the business money',
        parameters: z.object({ asOf: z.string(), limit: z.number().int().nullable() }),
      },
    ];
    const events: AiChatEvent[] = [];
    for await (const ev of p.chat([{ role: 'user', content: 'Who owes me money?' }], tools))
      events.push(ev);
    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      id: 'toolu_1',
      name: 'party_outstanding',
      arguments: { asOf: '2026-11-07' },
    });
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('Let me look.');
    const tool = api.calls[0]!.body.tools[0];
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(['asOf', 'limit']);
    expect(api.calls[0]!.body.tool_choice).toBeUndefined();

    const second: AiChatEvent[] = [];
    for await (const ev of p.chat(
      [
        { role: 'user', content: 'Who owes me money?' },
        {
          role: 'assistant',
          content: 'Let me look.',
          toolCalls: [
            { id: 'toolu_1', name: 'party_outstanding', arguments: { asOf: '2026-11-07' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'toolu_1',
          content: JSON.stringify([{ party: 'A', paise: 1200000 }]),
        },
      ],
      tools,
    ))
      second.push(ev);
    expect(second.at(-1)?.type).toBe('done');
    const msgs = api.calls[1]!.body.messages;
    expect(msgs[1].content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });

  it('answers over documents with citations on, and returns what was cited', async () => {
    const api = fakeApi([
      {
        content: [
          {
            type: 'text',
            text: 'A credit note must be issued by 30 November of the following year.',
            citations: [
              {
                type: 'char_location',
                cited_text: 'not later than the thirtieth day of November',
                document_index: 1,
                document_title: 'Section 34',
                start_char_index: 0,
                end_char_index: 40,
                file_id: null,
              },
            ],
          },
        ],
      },
    ]);
    const r = await provider(api).answerWithCitations('Until when can I issue a credit note?', [
      { title: 'Rule 46', text: 'A tax invoice shall contain...' },
      {
        title: 'Section 34',
        text: 'not later than the thirtieth day of November following the end of the financial year',
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.citations).toEqual([
      {
        documentIndex: 1,
        title: 'Section 34',
        citedText: 'not later than the thirtieth day of November',
      },
    ]);
    const content = api.calls[0]!.body.messages[0].content;
    expect(content[0]).toMatchObject({
      type: 'document',
      title: 'Rule 46',
      citations: { enabled: true },
    });
    expect(api.calls[0]!.body.output_config).toBeUndefined();
  });

  it('a batch is created from items, polled, and its results checked per item in any order', async () => {
    const api = fakeApi([]);
    const p = provider(api);
    const schema = z.object({
      category: z.string(),
      partyName: z.string().nullable(),
      confidence: z.number(),
    });
    const items = [
      {
        customId: 'a',
        feature: 'categorise_statement',
        prompt: { feature: 'categorise_statement', input: { d: 'NEFT' } },
        schema,
      },
      {
        customId: 'b',
        feature: 'categorise_statement',
        prompt: { feature: 'categorise_statement', input: { d: 'RENT' } },
        schema,
      },
    ];
    const made = await p.createBatch(items);
    expect(made).toEqual({ id: 'batch_1', count: 2 });
    const req = api.calls[0]!.body.requests;
    expect(req[0].custom_id).toBe('a');
    expect(req[0].params.output_config.format.type).toBe('json_schema');
    expect(await p.batchStatus('batch_1')).toMatchObject({ ended: true });
    const results = await p.batchResults('batch_1', items);
    expect(results.find((r) => r.customId === 'b')).toMatchObject({
      ok: true,
      value: { category: 'rent' },
    });
    expect(results.find((r) => r.customId === 'a')).toMatchObject({ ok: false });
  });
});

describe('the corpus', () => {
  it('parses front matter, chunks by heading, and ranks the chunk that answers', () => {
    const f = parseCorpusFile(
      'credit-notes',
      '---\ntitle: Credit and debit notes (section 34)\nsource: https://example.gov.in/cgst-act#34\ndate: 2017-07-01\n---\n# When a credit note may be issued\nWhere a tax invoice has been issued and the taxable value or tax charged is found to exceed...\n\n# Time limit\nThe credit note shall be declared not later than the thirtieth day of November following the end of the financial year.\n',
    );
    expect(f.title).toBe('Credit and debit notes (section 34)');
    const chunks = chunkMarkdown(f);
    expect(chunks.map((c) => c.heading)).toEqual([
      'When a credit note may be issued',
      'Time limit',
    ]);
    const other = chunkMarkdown(
      parseCorpusFile(
        'rule-46',
        '---\ntitle: Tax invoice contents (rule 46)\nsource: x\ndate: 2017-06-28\n---\nA tax invoice shall contain the name, address and GSTIN of the supplier.\n',
      ),
    );
    const s = new CorpusSearch([...chunks, ...other]);
    const hits = s.search('until when can a credit note be declared, what is the time limit');
    expect(hits[0]!.heading).toBe('Time limit');
    expect(hits[0]!.source).toContain('cgst-act#34');
  });

  it('strict JSON schemas require every key and allow no extras, at every level', () => {
    const js = strictJsonSchema(
      z.object({
        a: z.string(),
        nested: z.object({ b: z.number().nullable() }),
        list: z.array(z.object({ c: z.boolean() })),
      }),
    ) as any;
    expect(js.required).toEqual(['a', 'nested', 'list']);
    expect(js.additionalProperties).toBe(false);
    expect(js.properties.nested.required).toEqual(['b']);
    expect(js.properties.list.items.additionalProperties).toBe(false);
    expect(js.$schema).toBeUndefined();
  });
});
