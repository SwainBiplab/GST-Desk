/**
 * The cloud AI gateway against a real Postgres with the model's HTTP mocked (prompt 48): the plan gate, the
 * cached prefix with the business profile and HSN excerpt, redaction, metering into usage_events and ai_calls
 * (no content), the 80% warning and the hard quota, refusals and schema misses, the bill matched and priced,
 * the mismatch explainer, the notice summary, ask-your-books over read-only tools, GST Q&A with citations from
 * the corpus, and the batch path.
 */
import type { CorpusIndex } from '@gst/ai';
import { AnthropicProvider } from '@gst/ai';
import corpus from '@gst/ai/data/gst-corpus.json';
import { DocumentFlowRepo, ItemRepo, PartyRepo, type Ctx } from '@gst/db';
import { gstinCheckChar } from '@gst/domain';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiGatewayService } from '../src/ai/service';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

const GSTIN = '27AABCD1234E1Z8';
const SUPPLIER_GSTIN = `27AAACB1234F1Z${gstinCheckChar('27AAACB1234F1Z')}`;
let pg: PgStack;
let t: TestApp;
let owner: Client;
let stranger: Client;
let orgId: string;
let businessId: string;
let userId: string;
let partyId: string;
let svc: AiGatewayService;

type Block =
  | { type: 'text'; text: string; citations?: unknown[] }
  | { type: 'tool_use'; id: string; name: string; input: unknown };
interface Canned {
  content: Block[];
  stop_reason?: string;
  stop_details?: unknown;
  usage?: Record<string, number>;
}
const calls: { url: string; body: any }[] = [];
const answers: (Canned | { status: number })[] = [];

function sse(c: Canned): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const usage = {
    input_tokens: 1200,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...c.usage,
  };
  let out = ev('message_start', {
    type: 'message_start',
    message: {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage,
    },
  });
  c.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '', citations: b.citations ? [] : null },
      });
      out += ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: b.text },
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
    usage: { ...usage, output_tokens: c.usage?.['output_tokens'] ?? 300 },
    context_management: null,
  });
  return out + ev('message_stop', { type: 'message_stop' });
}

let batchPolls = 0;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, body });
  const jsonRes = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/v1/messages/batches') && init?.method === 'POST')
    return jsonRes({
      id: 'batch_x',
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
      created_at: 'x',
      expires_at: 'x',
      archived_at: null,
      cancel_initiated_at: null,
      results_url: null,
    });
  if (/\/batches\/batch_x$/.test(url)) {
    batchPolls++;
    const ended = batchPolls >= 2;
    return jsonRes({
      id: 'batch_x',
      type: 'message_batch',
      processing_status: ended ? 'ended' : 'in_progress',
      request_counts: {
        processing: ended ? 0 : 2,
        succeeded: ended ? 2 : 0,
        errored: 0,
        expired: 0,
        canceled: 0,
      },
      ended_at: null,
      created_at: 'x',
      expires_at: 'x',
      archived_at: null,
      cancel_initiated_at: null,
      results_url: ended ? 'https://api.anthropic.com/v1/messages/batches/batch_x/results' : null,
    });
  }
  if (/\/batches\/batch_x\/results$/.test(url)) {
    const line = (custom_id: string, text: string) =>
      JSON.stringify({
        custom_id,
        result: {
          type: 'succeeded',
          message: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 400, output_tokens: 60 },
          },
        },
      });
    return new Response(
      `${line('one', JSON.stringify(bill('Alpha Metals')))}\n${line('two', JSON.stringify(bill('Beta Steel')))}\n`,
      { status: 200, headers: { 'content-type': 'application/x-jsonl' } },
    );
  }
  const a = answers.shift();
  if (!a)
    return jsonRes({ type: 'error', error: { type: 'api_error', message: 'nothing canned' } }, 500);
  if ('status' in a)
    return jsonRes(
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
      a.status,
    );
  return new Response(sse(a), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const bill = (supplier: string) => ({
  supplierName: supplier,
  supplierGstin: SUPPLIER_GSTIN,
  invoiceNumber: 'SB/042',
  date: '2026-10-15',
  lines: [
    { description: 'Copper wire 2.5mm', hsn: '7408', qty: 10, ratePaise: 95000, gstRateBp: 1800 },
  ],
  totalPaise: 1121000,
});
const text = (c: Canned['content'][number]) => c;
const ctx = (): Ctx => ({ orgId, businessId, actor: userId, deviceId: 'api' });
const sql = (q: string) =>
  pg.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(q);
  }) as Promise<Record<string, any>[]>;
const body = (o: unknown) => ({ method: 'POST', body: JSON.stringify(o) });
const ai = (path: string) => `/v1/orgs/${orgId}/ai${path}`;

beforeAll(async () => {
  pg = await startPostgres();
  const provider = new AnthropicProvider({
    apiKey: 'sk-ant-test',
    fetch: fakeFetch,
    maxRetries: 0,
  });
  svc = new AiGatewayService({
    db: pg.app,
    provider,
    corpus: corpus as CorpusIndex,
    log: pino({ level: 'silent' }),
    enqueue: null,
  });
  t = makeTestApp(pg, { ai: svc });
  owner = await t.signIn('ai-owner@example.com', 'Asha');
  stranger = await t.signIn('ai-stranger@example.com', 'Nobody');
  userId = String(
    (await pg.app.sql`SELECT id FROM auth_user WHERE email = 'ai-owner@example.com'`)[0]!['id'],
  );
  orgId = (await owner.json<{ id: string }>('/v1/orgs', body({ name: 'Asha Traders' }))).body.id;
  businessId = (
    await owner.json<{ id: string }>(
      `/v1/orgs/${orgId}/businesses`,
      body({ legalName: 'Asha Traders', tradeName: 'Asha Traders', stateCode: '27', gstin: GSTIN }),
    )
  ).body.id;
  partyId = String(
    (
      await new PartyRepo(pg.app).create(ctx(), {
        type: 'supplier',
        name: 'Alpha Metals',
        state_code: '27',
        gstin: SUPPLIER_GSTIN,
      })
    )['id'],
  );
  await new ItemRepo(pg.app).create(ctx(), {
    name: 'Copper wire 2.5mm',
    hsn: '7408',
    gst_rate_bp: 1800,
    purchase_rate_paise: 95000,
  } as never);
  const flow = new DocumentFlowRepo(pg.app);
  const saved = await flow.saveDraft(
    ctx(),
    toRows(invoiceDraft(partyId, 'Alpha Metals', '2026-10-01', 10_000n)),
  );
  await flow.issueDraft(ctx(), String(saved.document['id']), Number(saved.document['version']));
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

describe('the plan gate', () => {
  it('a free organisation is told cloud AI is part of the plan; status says so', async () => {
    const st = await owner.json<any>(ai('/status'));
    expect(st.body).toMatchObject({ enabled: false, configured: true, limit: 0 });
    const r = await owner.json<any>(ai('/extract-bill'), body({ businessId, text: 'x' }));
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('ai_plan');
    expect(calls.length).toBe(0);
    await pg.admin.sql`UPDATE subscriptions SET plan_id = 'cloud' WHERE org_id = ${orgId}`;
    expect((await owner.json<any>(ai('/status'))).body).toMatchObject({
      enabled: true,
      limit: 2_000_000,
      used: 0,
    });
    expect((await stranger.json(ai('/status'))).status).toBe(404);
  });
});

describe('extracting a bill', () => {
  it('sends the cached business prefix, masks a PAN, meters the tokens, and matches and prices the bill', async () => {
    answers.push({
      content: [text({ type: 'text', text: JSON.stringify(bill('Alpha Metals')) })],
      usage: { cache_creation_input_tokens: 800 },
    });
    const r = await owner.json<any>(
      ai('/extract-bill'),
      body({
        businessId,
        text: 'TAX INVOICE SB/042 Alpha Metals PAN AAACB1234F ... total 11,210.00',
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bill.supplierName).toBe('Alpha Metals');
    expect(r.body.supplier.partyId).toBe(partyId);
    expect(r.body.lineMatches[0].itemId).toBeTruthy();
    expect(r.body.checks).toMatchObject({ totalsAgree: true, gstinValid: true, dateSane: true });
    expect(r.body.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cacheWriteTokens: 800,
    });
    expect(r.body.quota).toMatchObject({ used: 1500, limit: 2_000_000, warning: false });
    const req = calls.at(-1)!.body;
    const system = req.system.map((b: any) => b.text).join('\n');
    expect(system).toContain('Asha Traders, GSTIN 27AABCD1234E1Z8');
    expect(system).toContain('7408: Copper wire 2.5mm');
    expect(req.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(req.messages)).not.toContain('AAACB1234F ...');
    expect(JSON.stringify(req.messages)).toContain('[PAN_1]');
    // metered, and logged without content
    const usage = await sql(
      `SELECT kind, quantity, ref FROM usage_events WHERE kind = 'ai_tokens'`,
    );
    expect(usage).toEqual([{ kind: 'ai_tokens', quantity: 1500, ref: 'bill_extract' }]);
    const logged = await sql(
      `SELECT feature, provider, model, input_tokens, output_tokens, outcome FROM ai_calls`,
    );
    expect(logged).toEqual([
      {
        feature: 'bill_extract',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        input_tokens: 1200,
        output_tokens: 300,
        outcome: 'ok',
      },
    ]);
    expect(Object.keys(logged[0]!)).not.toContain('prompt');
  });

  it('the second call carries the same prefix bytes and reports the cache read', async () => {
    const before = calls.at(-1)!.body.system;
    answers.push({
      content: [text({ type: 'text', text: JSON.stringify(bill('Alpha Metals')) })],
      usage: { cache_read_input_tokens: 800 },
    });
    const r = await owner.json<any>(
      ai('/extract-bill'),
      body({ businessId, text: 'TAX INVOICE SB/042 Alpha Metals total 11,210.00' }),
    );
    expect(r.body.usage.cacheReadTokens).toBe(800);
    expect(JSON.stringify(calls.at(-1)!.body.system)).toBe(JSON.stringify(before));
  });

  it('a refusal and a schema miss are plain errors, logged as such, and nothing half-valid comes back', async () => {
    answers.push({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
    });
    const r = await owner.json<any>(ai('/extract-bill'), body({ businessId, text: 'x' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ai_refused');
    answers.push({
      content: [text({ type: 'text', text: JSON.stringify({ supplierName: 'A' }) })],
    });
    const r2 = await owner.json<any>(ai('/extract-bill'), body({ businessId, text: 'x' }));
    expect(r2.body.error.code).toBe('ai_invalid');
    const outcomes = await sql(`SELECT outcome FROM ai_calls ORDER BY created_at`);
    expect(outcomes.map((o) => o['outcome'])).toEqual(['ok', 'ok', 'refused', 'invalid_output']);
    // a failed call meters nothing
    expect(
      (await sql(`SELECT count(*)::int AS n FROM usage_events WHERE kind = 'ai_tokens'`))[0]!['n'],
    ).toBe(2);
  });

  it('the file itself can be sent, as an image block', async () => {
    answers.push({ content: [text({ type: 'text', text: JSON.stringify(bill('Alpha Metals')) })] });
    const r = await owner.json<any>(
      ai('/extract-bill'),
      body({
        businessId,
        file: {
          name: 'bill.png',
          mime: 'image/png',
          base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(calls.at(-1)!.body.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png' },
    });
  });
});

describe('the quota', () => {
  it('warns at 80% and refuses at the limit, before any call is made', async () => {
    await pg.admin
      .sql`UPDATE plans SET limits_json = jsonb_set(limits_json, '{aiTokens}', '5000') WHERE id = 'cloud'`;
    const st = await owner.json<any>(ai('/status'));
    expect(st.body).toMatchObject({ used: 4500, limit: 5000, warning: true });
    answers.push({ content: [text({ type: 'text', text: JSON.stringify(bill('Alpha Metals')) })] });
    const ok = await owner.json<any>(ai('/extract-bill'), body({ businessId, text: 'x' }));
    expect(ok.status).toBe(200);
    expect(ok.body.quota).toMatchObject({ used: 6000, warning: true });
    const n = calls.length;
    const r = await owner.json<any>(ai('/extract-bill'), body({ businessId, text: 'x' }));
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('ai_quota');
    expect(r.body.error.message).toContain('used up');
    expect(calls.length).toBe(n);
    await pg.admin
      .sql`UPDATE plans SET limits_json = jsonb_set(limits_json, '{aiTokens}', '2000000') WHERE id = 'cloud'`;
  });

  it('a mismatch row larger than 32 KB is refused before any call', async () => {
    const n = calls.length;
    const r = await owner.json<any>(
      ai('/explain-mismatch'),
      body({ businessId, row: { pad: 'x'.repeat(40_000) } }),
    );
    expect(r.status).toBe(400);
    expect(calls.length).toBe(n);
  });

  it('a rate-limited model is a 502 and the offline tiers are the caller’s fallback', async () => {
    answers.push({ status: 429 });
    const r = await owner.json<any>(ai('/explain-mismatch'), body({ businessId, row: {} }));
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ai_unavailable');
  });
});

describe('the other routes', () => {
  it('explains a mismatch and summarises a notice in their schemas', async () => {
    answers.push({
      content: [
        text({
          type: 'text',
          text: JSON.stringify({
            explanation: 'The supplier filed it a month late.',
            likelyCause: 'wrong_period',
            suggestedAction: 'Take the credit next month.',
            confidence: 0.8,
          }),
        }),
      ],
    });
    const e = await owner.json<any>(
      ai('/explain-mismatch'),
      body({
        businessId,
        row: {
          bill: { number: 'B-1', taxable: 100000 },
          entry: null,
          match: { cls: 'in_books_not_in_2b' },
        },
      }),
    );
    expect(e.status).toBe(200);
    expect(e.body.likelyCause).toBe('wrong_period');
    expect(calls.at(-1)!.body.messages[0].content).toContain('in_books_not_in_2b');
    answers.push({
      content: [
        text({
          type: 'text',
          text: JSON.stringify({
            noticeType: 'Scrutiny notice',
            form: 'ASMT-10',
            issuedBy: 'State Tax Officer, Pune',
            referenceNumber: 'ZD2711230001',
            dateIssued: '2026-10-20',
            dueDate: '2026-11-19',
            demandPaise: null,
            summary: 'Differences between GSTR-1 and GSTR-3B for 2025-26.',
            actions: ['Reconcile the two returns', 'Reply in ASMT-11 by 19 November'],
            references: ['Section 61', 'Rule 99'],
            needsProfessional: true,
          }),
        }),
      ],
    });
    const n = await owner.json<any>(
      ai('/summarise-notice'),
      body({ businessId, text: 'FORM GST ASMT-10 ... notice for intimating discrepancies ...' }),
    );
    expect(n.status).toBe(200);
    expect(n.body).toMatchObject({
      form: 'ASMT-10',
      dueDate: '2026-11-19',
      needsProfessional: true,
    });
    expect(n.body.actions).toHaveLength(2);
  });

  it('ask-your-books runs the model over read-only tools scoped to the business', async () => {
    answers.push({
      content: [
        text({ type: 'text', text: 'Let me check.' }),
        { type: 'tool_use', id: 'toolu_1', name: 'party_outstanding', input: { side: 'payable' } },
      ],
      stop_reason: 'tool_use',
    });
    answers.push({ content: [text({ type: 'text', text: 'You owe Alpha Metals Rs 256.00.' })] });
    const r = await owner.json<any>(
      ai('/ask-books'),
      body({ businessId, question: 'Whom do I owe money?' }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.answer).toContain('Alpha Metals');
    expect(r.body.toolCalls).toEqual([
      { name: 'party_outstanding', arguments: { side: 'payable' } },
    ]);
    expect(r.body.usage.inputTokens).toBe(2400);
    const second = calls.at(-1)!.body;
    const tools = calls.at(-2)!.body.tools.map((x: any) => x.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'sales_register',
        'party_outstanding',
        'find_party',
        'find_documents',
      ]),
    );
    expect(calls.at(-2)!.body.tools.every((x: any) => x.strict === true)).toBe(true);
    expect(calls.at(-2)!.body.tool_choice).toBeUndefined();
    const toolResult = second.messages.at(-1).content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe('toolu_1');
    expect(second.messages.at(-1).content.length).toBe(1);
    // the tool answered from this business's books
    expect(JSON.parse(toolResult.content)).toMatchObject({ count: expect.any(Number) });
    // a viewer may ask; a stranger may not
    expect(
      (await stranger.json(ai('/ask-books'), body({ businessId, question: 'x' }))).status,
    ).toBe(404);
  });

  it('GST Q&A retrieves from the corpus, answers with citations, and never without the disclaimer', async () => {
    answers.push({
      content: [
        text({
          type: 'text',
          text: 'A credit note must be declared by 30 November following the end of the financial year.',
          citations: [
            {
              type: 'char_location',
              cited_text: 'not later than the thirtieth day of November',
              document_index: 0,
              document_title:
                'Credit and debit notes (section 34, rule 53) — Time limit for a credit note',
              start_char_index: 0,
              end_char_index: 10,
              file_id: null,
            },
          ],
        }),
      ],
    });
    const r = await owner.json<any>(
      ai('/gst-qa'),
      body({ businessId, question: 'Until when can I issue a credit note for last year?' }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.covered).toBe(true);
    expect(r.body.answer).toContain('30 November');
    expect(r.body.disclaimer).toContain('not legal');
    expect(r.body.sources.length).toBeGreaterThan(0);
    const docs = calls.at(-1)!.body.messages[0].content.filter((b: any) => b.type === 'document');
    expect(docs.length).toBeGreaterThanOrEqual(3);
    expect(docs[0].citations).toEqual({ enabled: true });
    expect(docs.map((d: any) => d.title)).toContainEqual(
      expect.stringContaining('Credit notes and debit notes'),
    );
    expect(r.body.sources[0].source).toContain('cbic-gst.gov.in');
    // nothing in the notes: no call is made
    const n = calls.length;
    const none = await owner.json<any>(ai('/gst-qa'), body({ businessId, question: 'zzzz qqqq' }));
    expect(none.body.covered).toBe(false);
    expect(calls.length).toBe(n);
  });

  it('drafts a message', async () => {
    answers.push({
      content: [
        text({
          type: 'text',
          text: JSON.stringify({
            text: 'Namaste, aapka bill INV-1 ready hai.',
            language: 'hinglish',
          }),
        }),
      ],
    });
    const r = await owner.json<any>(
      ai('/draft-message'),
      body({
        businessId,
        kind: 'invoice',
        language: 'hinglish',
        context: { number: 'INV-1', amount: '1,180.00' },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('INV-1');
  });
});

describe('the batch path', () => {
  it('submits a batch, polls until it ends, checks each result against the schema and meters the tokens', async () => {
    const before = Number(
      (
        await sql(
          `SELECT coalesce(sum(quantity),0)::int AS n FROM usage_events WHERE kind = 'ai_tokens'`,
        )
      )[0]!['n'],
    );
    const r = await owner.json<any>(
      ai('/batches'),
      body({
        businessId,
        kind: 'extract_bills',
        items: [
          { id: 'one', text: 'bill one' },
          { id: 'two', text: 'bill two' },
        ],
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.status).toBe('done'); // no queue in the test: submit and poll ran inline
    expect(r.body.results.map((x: any) => x.customId).sort()).toEqual(['one', 'two']);
    expect(r.body.results.every((x: any) => x.ok)).toBe(true);
    expect(r.body.results.find((x: any) => x.customId === 'two').value.supplierName).toBe(
      'Beta Steel',
    );
    const after = Number(
      (
        await sql(
          `SELECT coalesce(sum(quantity),0)::int AS n FROM usage_events WHERE kind = 'ai_tokens'`,
        )
      )[0]!['n'],
    );
    expect(after - before).toBe(920);
    const created = calls.find((c) => c.url.endsWith('/v1/messages/batches'))!.body;
    expect(created.requests).toHaveLength(2);
    expect(created.requests[0].params.output_config.format.type).toBe('json_schema');
    const list = await owner.json<any[]>(ai(`/batches?businessId=${businessId}`));
    expect(list.body[0].id).toBe(r.body.id);
    expect((await owner.json<any>(ai(`/batches/${r.body.id}`))).body.counts.succeeded).toBe(2);
  });
});
