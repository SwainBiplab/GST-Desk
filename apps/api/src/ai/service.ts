/**
 * The cloud AI gateway (prompt 48): the one place the cloud model is called for an organisation. Every route
 * checks the plan and the month's token quota (a soft warning at 80%, a hard stop at the limit), assembles the
 * prompt with a stable cached prefix (the business profile and its HSN excerpt) and a volatile suffix, lets the
 * provider mask identifiers, validates the answer against the route's schema, meters the tokens into
 * `usage_events` and the attempt into `ai_calls`, and keeps no content: logs carry the feature, tokens and
 * latency only. Ask-your-books runs the model over read-only report tools scoped to the business; GST Q&A
 * answers over the curated corpus with citations and the not-legal-advice line.
 */
import {
  AnthropicProvider,
  CorpusSearch,
  NOT_LEGAL_ADVICE,
  draftMessageSchema,
  engineTotals,
  matchItem,
  matchSupplier,
  mismatchExplanationSchema,
  noticeSummarySchema,
  purchaseBillSchema,
  statementCategorySchema,
  type AiDocument,
  type AiMessage,
  type AiResult,
  type AiTool,
  type AiToolCall,
  type AiUsage,
  type BatchItem,
  type Citation,
  type CorpusIndex,
  type DraftMessage,
  type MismatchExplanation,
  type NoticeSummary,
  type PurchaseBill,
} from '@gst/ai';
import { DbCallLogger } from '@gst/ai/db';
import {
  DocumentRepo,
  ItemRepo,
  PartyRepo,
  newId,
  runReport,
  type Ctx,
  type ReportId,
  type Row,
} from '@gst/db';
import { checkGstin } from '@gst/domain';
import { istDate, istInstant } from '@gst/messaging';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { PgDatabase } from '../db/pool';

export const SOFT_WARNING = 0.8;
export const MAX_TOOL_ROUNDS = 6;
export const BATCH_POLL_MS = 60_000;
export const BATCH_MAX_POLLS = 24 * 60;
const CONTEXT_TTL_MS = 5 * 60_000;

export class AiGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no_provider'
      | 'plan'
      | 'quota'
      | 'refused'
      | 'invalid'
      | 'unavailable'
      | 'not_found'
      | 'validation',
  ) {
    super(message);
  }
}

export interface Quota {
  enabled: boolean;
  used: number;
  limit: number;
  /** At or past 80% of the month's tokens. */
  warning: boolean;
}

export interface GatewayMeta {
  model: string;
  usage: AiUsage;
  latencyMs: number;
  quota: Quota;
}

const monthStart = (ms: number): number => istInstant(`${istDate(ms).slice(0, 7)}-01`, '00:00');
const tokensOf = (u: AiUsage | undefined) => (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);

type ToolSpec = AiTool & { run: (args: Record<string, unknown>) => Promise<unknown> };

export class AiGatewayService {
  private readonly contexts = new Map<string, { at: number; profile: string; hsn: string }>();
  private readonly corpus: CorpusSearch;

  constructor(
    private readonly o: {
      db: PgDatabase;
      provider: AnthropicProvider | null;
      corpus: CorpusIndex | null;
      log: Logger;
      now?: () => number;
      /** The batch job's enqueuer; null runs the first poll inline (tests). */
      enqueue:
        ((job: { orgId: string; batchId: string }, delayMs?: number) => Promise<void>) | null;
    },
  ) {
    this.corpus = new CorpusSearch(o.corpus?.chunks ?? []);
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private org<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return this.o.db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  private ctx(orgId: string, businessId: string, actor: string): Ctx {
    return { orgId, businessId, actor, deviceId: 'api' };
  }

  private provider(): AnthropicProvider {
    if (!this.o.provider)
      throw new AiGatewayError('Cloud AI is not set up on this server.', 'no_provider');
    return this.o.provider;
  }

  /* ------------------------------------------------------------------------------ plan and quota */

  async quota(orgId: string): Promise<Quota> {
    return this.org(orgId, async (tx) => {
      const [p] =
        await tx`SELECT s.status, pl.limits_json FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.org_id = ${orgId}`;
      const limit = Number(
        (p?.['limits_json'] as { aiTokens?: number } | undefined)?.aiTokens ?? 0,
      );
      const active = p && ['active', 'trial'].includes(String(p['status']));
      const [u] =
        await tx`SELECT coalesce(sum(quantity), 0)::bigint AS n FROM usage_events WHERE org_id = ${orgId} AND kind = 'ai_tokens' AND at >= ${monthStart(this.now())}`;
      const used = Number(u?.['n'] ?? 0);
      return {
        enabled: !!active && limit > 0 && !!this.o.provider,
        used,
        limit,
        warning: limit > 0 && used >= limit * SOFT_WARNING,
      };
    });
  }

  private async gate(orgId: string): Promise<Quota> {
    this.provider();
    const q = await this.quota(orgId);
    if (!q.enabled) throw new AiGatewayError('Cloud AI is part of the cloud plan.', 'plan');
    if (q.used >= q.limit)
      throw new AiGatewayError(
        `This month's ${q.limit.toLocaleString('en-IN')} cloud AI tokens are used up; the offline tiers still work.`,
        'quota',
      );
    return q;
  }

  /** Tokens into the plan's meter, the attempt into `ai_calls`; nothing else is kept. */
  private async meter(
    ctx: Ctx,
    feature: string,
    capability: 'extract' | 'suggest' | 'chat',
    r:
      | { ok: true; model: string; usage?: AiUsage | undefined; latencyMs: number }
      | { ok: false; code: string; latencyMs: number },
  ): Promise<Quota> {
    const now = this.now();
    if (r.ok) {
      const n = tokensOf(r.usage);
      if (n > 0)
        await this.org(
          ctx.orgId,
          (tx) =>
            tx`INSERT INTO usage_events (id, org_id, business_id, kind, quantity, ref, at, created_at) VALUES (${newId()}, ${ctx.orgId}, ${ctx.businessId}, 'ai_tokens', ${n}, ${feature}, ${now}, ${now})`,
        );
    }
    await new DbCallLogger(this.o.db, ctx)
      .log({
        feature,
        capability,
        provider: 'anthropic',
        ...(r.ok
          ? {
              model: r.model,
              ...(r.usage?.inputTokens !== undefined ? { inputTokens: r.usage.inputTokens } : {}),
              ...(r.usage?.outputTokens !== undefined
                ? { outputTokens: r.usage.outputTokens }
                : {}),
              outcome: 'ok' as const,
            }
          : { outcome: r.code as never }),
        latencyMs: r.latencyMs,
      })
      .catch(() => undefined);
    this.o.log.info(
      {
        feature,
        ok: r.ok,
        ...(r.ok ? { tokens: tokensOf(r.usage) } : { code: r.code }),
        latencyMs: r.latencyMs,
      },
      'ai call',
    );
    return this.quota(ctx.orgId);
  }

  /* ------------------------------------------------------------------------- the cached prefix */

  /** The business profile and HSN excerpt: the same bytes for five minutes, so the prefix caches. */
  private async context(ctx: Ctx): Promise<{ profile: string; hsnExcerpt: string }> {
    const key = `${ctx.orgId}:${ctx.businessId}`;
    const hit = this.contexts.get(key);
    const now = this.now();
    if (hit && now - hit.at < CONTEXT_TTL_MS) return { profile: hit.profile, hsnExcerpt: hit.hsn };
    const [b] = await this.org<Row[]>(
      ctx.orgId,
      (tx) =>
        tx`SELECT trade_name, legal_name, gstin, state_code, scheme, fy_start_month FROM businesses WHERE id = ${ctx.businessId}`,
    );
    const hsn = await this.org<Row[]>(
      ctx.orgId,
      (tx) =>
        tx`SELECT hsn, min(name) AS name FROM items WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND hsn IS NOT NULL AND hsn <> ''
           GROUP BY hsn ORDER BY hsn LIMIT 40`,
    );
    const profile = b
      ? `${String(b['trade_name'] || b['legal_name'])}${b['gstin'] ? `, GSTIN ${b['gstin']}` : ''}, state code ${b['state_code']}, ${b['scheme']} scheme, financial year starts month ${b['fy_start_month'] ?? 4}.`
      : '';
    const hsnExcerpt = (hsn as Row[]).map((r) => `${r['hsn']}: ${r['name']}`).join('\n');
    this.contexts.set(key, { at: now, profile, hsn: hsnExcerpt });
    return { profile, hsnExcerpt };
  }

  private async hints(ctx: Ctx) {
    const c = await this.context(ctx);
    return { profile: c.profile, hsnExcerpt: c.hsnExcerpt };
  }

  private async run<T>(
    ctx: Ctx,
    feature: string,
    capability: 'extract' | 'suggest' | 'chat',
    fn: (p: AnthropicProvider) => Promise<AiResult<T>>,
  ): Promise<{ value: T; meta: GatewayMeta }> {
    await this.gate(ctx.orgId);
    const started = this.now();
    const r = await fn(this.provider());
    const latencyMs = Math.max(0, this.now() - started);
    if (!r.ok) {
      const quota = await this.meter(ctx, feature, capability, {
        ok: false,
        code: r.error.code,
        latencyMs,
      });
      void quota;
      const code =
        r.error.code === 'refused'
          ? 'refused'
          : r.error.code === 'invalid_output'
            ? 'invalid'
            : 'unavailable';
      throw new AiGatewayError(r.error.message, code);
    }
    const quota = await this.meter(ctx, feature, capability, {
      ok: true,
      model: r.model,
      usage: r.usage,
      latencyMs: r.latencyMs || latencyMs,
    });
    return {
      value: r.value,
      meta: { model: r.model, usage: r.usage ?? {}, latencyMs: r.latencyMs || latencyMs, quota },
    };
  }

  /* -------------------------------------------------------------------------------- the routes */

  /** A purchase bill from its text (read on the device) or its image or PDF; matched and priced like Tier 1. */
  async extractBill(
    orgId: string,
    businessId: string,
    by: string,
    input: {
      text?: string | undefined;
      file?: { name: string; mime: string; bytes: Uint8Array } | undefined;
    },
  ) {
    const ctx = this.ctx(orgId, businessId, by);
    const doc: AiDocument = input.file
      ? {
          kind: input.file.mime === 'application/pdf' ? 'pdf' : 'image',
          bytes: input.file.bytes,
          mime: input.file.mime,
          name: input.file.name,
          ...(input.text ? { text: input.text } : {}),
        }
      : { kind: 'text', text: input.text ?? '' };
    const hints = await this.hints(ctx);
    const { value: bill, meta } = await this.run<PurchaseBill>(
      ctx,
      'bill_extract',
      'extract',
      (p) =>
        p.extract(doc, purchaseBillSchema, {
          feature: 'bill_extract',
          schemaName: 'purchaseBill',
          hints,
        }),
    );
    // the same matching and checks the device applies: the engine prices the lines, the model never does
    const [parties, items, b] = await Promise.all([
      new PartyRepo(this.o.db).list(ctx),
      new ItemRepo(this.o.db).list(ctx),
      this.org(orgId, (tx) => tx`SELECT state_code FROM businesses WHERE id = ${businessId}`),
    ]);
    const supplier = matchSupplier(
      bill,
      parties.map((p) => ({
        id: String(p['id']),
        name: String(p['name']),
        gstin: (p['gstin'] as string | null) ?? null,
      })),
    );
    const lineMatches = bill.lines.map((l) =>
      matchItem(
        l,
        items.map((i) => ({
          id: String(i['id']),
          name: String(i['name']),
          hsn: (i['hsn'] as string | null) ?? null,
          purchaseRatePaise: Number(i['purchase_rate_paise'] ?? 0),
          gstRateBp: Number(i['gst_rate_bp'] ?? 0),
        })),
      ),
    );
    const t = engineTotals(
      bill,
      String((b as Row[])[0]?.['state_code'] ?? ''),
      bill.supplierGstin ? bill.supplierGstin.slice(0, 2) : null,
    );
    const today = istDate(this.now());
    const checks = {
      engineTotalPaise: t.totalPaise,
      engineTaxablePaise: t.taxablePaise,
      billTotalPaise: bill.totalPaise,
      totalsAgree: Math.abs(t.totalPaise - bill.totalPaise) <= 100,
      gstinValid: bill.supplierGstin ? checkGstin(bill.supplierGstin).valid : null,
      dateSane:
        bill.date <= today && bill.date >= `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`,
    };
    const fieldConfidence: Record<string, number> = {
      supplierName: 0.9,
      supplierGstin: checks.gstinValid === false ? 0.4 : 0.9,
      invoiceNumber: 0.9,
      date: checks.dateSane ? 0.9 : 0.4,
      lines: checks.totalsAgree ? 0.9 : 0.45,
      totalPaise: checks.totalsAgree ? 0.9 : 0.45,
    };
    return { bill, supplier, lineMatches, checks, fieldConfidence, ...meta };
  }

  async explainMismatch(orgId: string, businessId: string, by: string, row: unknown) {
    const ctx = this.ctx(orgId, businessId, by);
    const hints = await this.hints(ctx);
    const { value, meta } = await this.run<MismatchExplanation>(
      ctx,
      'explain_2b_mismatch',
      'suggest',
      (p) =>
        p.suggest({ feature: 'explain_2b_mismatch', input: row }, mismatchExplanationSchema, {
          hints,
        }),
    );
    return { ...value, ...meta };
  }

  async summariseNotice(
    orgId: string,
    businessId: string,
    by: string,
    input: {
      text?: string | undefined;
      file?: { name: string; mime: string; bytes: Uint8Array } | undefined;
    },
  ) {
    const ctx = this.ctx(orgId, businessId, by);
    const hints = await this.hints(ctx);
    const doc: AiDocument = input.file
      ? { kind: 'pdf', bytes: input.file.bytes, mime: 'application/pdf', name: input.file.name }
      : { kind: 'text', text: input.text ?? '' };
    const { value, meta } = await this.run<NoticeSummary>(ctx, 'summarise_notice', 'extract', (p) =>
      p.extract(doc, noticeSummarySchema, { feature: 'summarise_notice', hints }),
    );
    return { ...value, ...meta };
  }

  async draftMessage(
    orgId: string,
    businessId: string,
    by: string,
    input: { kind: string; language: string; context: Record<string, unknown> },
  ) {
    const ctx = this.ctx(orgId, businessId, by);
    const hints = await this.hints(ctx);
    const { value, meta } = await this.run<DraftMessage>(ctx, 'draft_message', 'suggest', (p) =>
      p.suggest({ feature: 'draft_message', input }, draftMessageSchema, { hints }),
    );
    return { ...value, ...meta };
  }

  /* ------------------------------------------------------------------------- ask your books */

  /** The read-only tools the assistant may call, every one scoped to the business by the repository context. */
  private tools(ctx: Ctx): ToolSpec[] {
    const today = istDate(this.now());
    const span = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const report = (id: ReportId, name: string, description: string): ToolSpec => ({
      name,
      description,
      parameters: span,
      run: async (a) => {
        const p = span.parse(a);
        const r = await runReport(
          this.o.db,
          ctx,
          id,
          { from: p.from, to: p.to, today },
          { offset: 0, limit: 40 },
        );
        return { count: r.count, totals: r.totals, rows: r.rows.slice(0, 40) };
      },
    });
    const partyQ = z.object({ query: z.string().min(1).max(80) });
    const docQ = z.object({ query: z.string().min(1).max(80) });
    return [
      report(
        'sales_register',
        'sales_register',
        'Sales documents between two dates (ISO), with totals in paise. At most 40 rows.',
      ),
      report(
        'purchase_register',
        'purchase_register',
        'Purchase bills between two dates (ISO), with totals in paise. At most 40 rows.',
      ),
      report(
        'gst_summary',
        'gst_summary',
        'Output tax and input credit by rate between two dates (ISO), in paise.',
      ),
      report(
        'document_summary',
        'document_summary',
        'Counts and totals of documents by type between two dates (ISO), in paise.',
      ),
      {
        name: 'party_outstanding',
        description:
          'Who owes the business money and whom the business owes, as of today, in paise.',
        parameters: z.object({ side: z.enum(['all', 'receivable', 'payable']) }),
        run: async (a) => {
          const p = z.object({ side: z.enum(['all', 'receivable', 'payable']) }).parse(a);
          const r = await runReport(this.o.db, ctx, 'party_outstanding', {
            from: '0001-01-01',
            to: today,
            today,
            side: p.side,
          });
          return { count: r.count, totals: r.totals, rows: r.rows.slice(0, 40) };
        },
      },
      {
        name: 'find_party',
        description: 'Find parties (customers or suppliers) by name, GSTIN or phone.',
        parameters: partyQ,
        run: async (a) => {
          const p = partyQ.parse(a);
          return (await new PartyRepo(this.o.db).search(ctx, p.query, 10)).map((r) => ({
            id: String(r['id']),
            name: r['name'],
            type: r['type'],
            gstin: r['gstin'] ?? null,
            state: r['state_code'] ?? null,
          }));
        },
      },
      {
        name: 'find_documents',
        description: 'Find documents by number, party name or words on them.',
        parameters: docQ,
        run: async (a) => {
          const p = docQ.parse(a);
          return (await new DocumentRepo(this.o.db).search(ctx, p.query, 10)).map((r) => ({
            id: String(r['id']),
            type: r['type'],
            number: r['number'] ?? null,
            date: r['date'],
            party: r['party_name'] ?? null,
            status: r['status'],
            totalPaise: Number(r['total_paise'] ?? 0),
          }));
        },
      },
    ];
  }

  async askBooks(
    orgId: string,
    businessId: string,
    by: string,
    question: string,
    history: { role: 'user' | 'assistant'; content: string }[] = [],
  ) {
    const ctx = this.ctx(orgId, businessId, by);
    await this.gate(orgId);
    const p = this.provider();
    const tools = this.tools(ctx);
    const hints = await this.hints(ctx);
    const messages: AiMessage[] = [
      ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ];
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const toolCalls: { name: string; arguments: unknown }[] = [];
    const started = this.now();
    let answer = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let text = '';
      const calls: AiToolCall[] = [];
      let error: { code: string; message: string } | null = null;
      for await (const ev of p.chat(messages, tools, { feature: 'ask_books', hints })) {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'tool_call') calls.push(ev);
        else if (ev.type === 'done') {
          usage.inputTokens! += ev.usage?.inputTokens ?? 0;
          usage.outputTokens! += ev.usage?.outputTokens ?? 0;
          usage.cacheReadTokens! += ev.usage?.cacheReadTokens ?? 0;
        } else if (ev.type === 'error') error = ev.error;
      }
      if (error) {
        const e: { code: string; message: string } = error;
        await this.meter(ctx, 'ask_books', 'chat', {
          ok: false,
          code: e.code,
          latencyMs: this.now() - started,
        });
        throw new AiGatewayError(e.message, e.code === 'refused' ? 'refused' : 'unavailable');
      }
      answer = text;
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: text, toolCalls: calls });
      for (const c of calls) {
        const tool = tools.find((t) => t.name === c.name);
        let result: string;
        try {
          if (!tool) throw new Error('no such tool');
          const out = await tool.run((c.arguments ?? {}) as Record<string, unknown>);
          result = JSON.stringify(out).slice(0, 12_000);
        } catch (e) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        toolCalls.push({ name: c.name, arguments: c.arguments });
        messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: result });
      }
      if (round === MAX_TOOL_ROUNDS)
        answer = `${answer}\n\n(I stopped after ${MAX_TOOL_ROUNDS} lookups.)`;
    }
    const latencyMs = this.now() - started;
    const quota = await this.meter(ctx, 'ask_books', 'chat', {
      ok: true,
      model: p.route('ask_books').model,
      usage,
      latencyMs,
    });
    return { answer, toolCalls, model: p.route('ask_books').model, usage, latencyMs, quota };
  }

  /* ---------------------------------------------------------------------------------- GST Q&A */

  async gstQa(orgId: string, businessId: string, by: string, question: string) {
    const ctx = this.ctx(orgId, businessId, by);
    const hits = this.corpus.search(question, 6);
    if (!hits.length)
      return {
        answer: 'The curated GST notes do not cover this question. Ask a chartered accountant.',
        sources: [] as {
          title: string;
          heading: string;
          source: string;
          date: string;
          quote: string;
        }[],
        disclaimer: NOT_LEGAL_ADVICE,
        covered: false,
        model: null as string | null,
        usage: {} as AiUsage,
        latencyMs: 0,
        quota: await this.quota(orgId),
      };
    const docs = hits.map((h) => ({ title: `${h.title} — ${h.heading}`, text: h.text }));
    const { value, meta } = await this.run<{ text: string; citations: Citation[] }>(
      ctx,
      'gst_qa',
      'chat',
      (p) => p.answerWithCitations(question, docs, { feature: 'gst_qa' }),
    );
    const cited = new Map<number, string[]>();
    for (const c of value.citations)
      cited.set(c.documentIndex, [...(cited.get(c.documentIndex) ?? []), c.citedText]);
    const indices = cited.size ? [...cited.keys()] : hits.map((_, i) => i);
    const sources = indices
      .filter((i) => hits[i])
      .map((i) => ({
        title: hits[i]!.title,
        heading: hits[i]!.heading,
        source: hits[i]!.source,
        date: hits[i]!.date,
        quote: (cited.get(i) ?? []).join(' … ').slice(0, 600),
      }));
    return { answer: value.text, sources, disclaimer: NOT_LEGAL_ADVICE, covered: true, ...meta };
  }

  /* ---------------------------------------------------------------------------------- batches */

  async createBatch(a: {
    orgId: string;
    businessId: string;
    by: string;
    kind: 'extract_bills' | 'categorise_statement';
    items: { id: string; text?: string | undefined; input?: unknown }[];
  }) {
    await this.gate(a.orgId);
    if (!a.items.length || a.items.length > 100)
      throw new AiGatewayError('Send between 1 and 100 items in a batch.', 'validation');
    const now = this.now();
    const id = newId();
    await this.org(
      a.orgId,
      (tx) =>
        tx`INSERT INTO ai_batches (id, org_id, business_id, kind, status, items_json, created_by, created_at, updated_at)
           VALUES (${id}, ${a.orgId}, ${a.businessId}, ${a.kind}, 'queued', ${JSON.stringify(a.items)}::jsonb, ${a.by}, ${now}, ${now})`,
    );
    if (this.o.enqueue) await this.o.enqueue({ orgId: a.orgId, batchId: id });
    else await this.runBatch(a.orgId, id);
    return (await this.batch(a.orgId, id))!;
  }

  private batchItems(
    kind: string,
    items: { id: string; text?: string | undefined; input?: unknown }[],
  ): BatchItem[] {
    return items.map((it) =>
      kind === 'extract_bills'
        ? {
            customId: it.id,
            feature: 'bill_extract',
            doc: { kind: 'text', text: it.text ?? '' },
            schema: purchaseBillSchema,
          }
        : {
            customId: it.id,
            feature: 'categorise_statement',
            prompt: { feature: 'categorise_statement', input: it.input ?? { text: it.text } },
            schema: statementCategorySchema,
          },
    );
  }

  /** One step of the batch job: submit, or poll; re-queued until the provider says it ended. */
  async runBatch(
    orgId: string,
    batchId: string,
  ): Promise<'submitted' | 'done' | 'failed' | 'waiting'> {
    const [row] = await this.org<Row[]>(
      orgId,
      (tx) => tx`SELECT * FROM ai_batches WHERE id = ${batchId}`,
    );
    if (!row) return 'failed';
    const now = this.now();
    const ctx = this.ctx(orgId, String(row['business_id']), String(row['created_by'] ?? 'system'));
    const items = this.batchItems(String(row['kind']), row['items_json'] as never);
    try {
      const p = this.provider();
      if (row['status'] === 'queued') {
        const made = await p.createBatch(items);
        await this.org(
          orgId,
          (tx) =>
            tx`UPDATE ai_batches SET status = 'submitted', provider_batch_id = ${made.id}, updated_at = ${now} WHERE id = ${batchId}`,
        );
        if (this.o.enqueue) await this.o.enqueue({ orgId, batchId }, BATCH_POLL_MS);
        else return this.runBatch(orgId, batchId);
        return 'submitted';
      }
      if (row['status'] !== 'submitted') return row['status'] as 'done' | 'failed';
      const st = await p.batchStatus(String(row['provider_batch_id']));
      if (!st.ended) {
        const polls = Number(row['polls'] ?? 0) + 1;
        await this.org(
          orgId,
          (tx) =>
            tx`UPDATE ai_batches SET polls = ${polls}, counts_json = ${JSON.stringify(st.counts)}::jsonb, updated_at = ${now} WHERE id = ${batchId}`,
        );
        if (polls >= BATCH_MAX_POLLS) throw new Error('the batch did not end within a day');
        if (this.o.enqueue) await this.o.enqueue({ orgId, batchId }, BATCH_POLL_MS);
        else return this.runBatch(orgId, batchId); // no queue: poll again now (tests)
        return 'waiting';
      }
      const results = await p.batchResults(String(row['provider_batch_id']), items);
      let tokens = 0;
      for (const r of results) if (r.ok) tokens += tokensOf(r.usage);
      if (tokens > 0)
        await this.org(
          orgId,
          (tx) =>
            tx`INSERT INTO usage_events (id, org_id, business_id, kind, quantity, ref, at, created_at) VALUES (${newId()}, ${orgId}, ${ctx.businessId}, 'ai_tokens', ${tokens}, ${`batch:${batchId}`}, ${now}, ${now})`,
        );
      await new DbCallLogger(this.o.db, ctx)
        .log({
          feature: `batch:${String(row['kind'])}`,
          capability: 'extract',
          provider: 'anthropic',
          model: p.route('bill_extract').model,
          inputTokens: results.reduce((a, r) => a + (r.ok ? (r.usage.inputTokens ?? 0) : 0), 0),
          outputTokens: results.reduce((a, r) => a + (r.ok ? (r.usage.outputTokens ?? 0) : 0), 0),
          latencyMs: Math.max(0, now - Number(row['created_at'])),
          outcome: 'ok',
        })
        .catch(() => undefined);
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE ai_batches SET status = 'done', results_json = ${JSON.stringify(results)}::jsonb, counts_json = ${JSON.stringify(st.counts)}::jsonb,
             finished_at = ${now}, updated_at = ${now} WHERE id = ${batchId}`,
      );
      return 'done';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.o.log.warn({ orgId, batchId, err: msg }, 'ai batch failed');
      await this.org(
        orgId,
        (tx) =>
          tx`UPDATE ai_batches SET status = 'failed', error = ${msg.slice(0, 500)}, finished_at = ${now}, updated_at = ${now} WHERE id = ${batchId}`,
      );
      return 'failed';
    }
  }

  async batch(orgId: string, id: string) {
    const [r] = await this.org<Row[]>(orgId, (tx) => tx`SELECT * FROM ai_batches WHERE id = ${id}`);
    return r ? batchView(r) : null;
  }

  async batches(orgId: string, businessId: string) {
    const rows = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM ai_batches WHERE business_id = ${businessId} ORDER BY created_at DESC LIMIT 50`,
    );
    return (rows as Row[]).map(batchView);
  }
}

const batchView = (r: Row) => ({
  id: String(r['id']),
  businessId: String(r['business_id']),
  kind: String(r['kind']),
  status: String(r['status']) as 'queued' | 'submitted' | 'done' | 'failed',
  items: ((r['items_json'] as { id: string }[]) ?? []).length,
  counts: (r['counts_json'] as Record<string, number> | null) ?? null,
  results: (r['results_json'] as unknown[] | null) ?? null,
  error: (r['error'] as string | null) ?? null,
  createdAt: Number(r['created_at']),
  finishedAt: r['finished_at'] == null ? null : Number(r['finished_at']),
});
