/**
 * The document editor's persistence: save a draft (touching only what changed), issue it
 * (number, ledger posting, stock, reverse-charge self-invoice in one transaction) and load or delete
 * drafts. Money is never computed here: rows arrive from `buildDocument` in `@gst/domain` and are
 * checked by `consistencyValidator` before they are written.
 */
import {
  POSTS_TO_LEDGER,
  canIssue,
  fyOf,
  postDocument,
  stockEffect,
  takeNext,
  type AccountKey,
  type DocumentType,
} from '@gst/domain';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import { BusinessRepo, DocumentRepo, type DocumentWithLines } from './aggregates';
import { BaseRepo, ConflictError, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import { consistencyValidator } from './line-math';

const DEFAULT_PREFIX: Record<string, string> = {
  tax_invoice: 'INV/{FY}/',
  bill_of_supply: 'BOS/{FY}/',
  proforma: 'PI/{FY}/',
  quotation: 'QT/{FY}/',
  credit_note: 'CN/{FY}/',
  debit_note: 'DN/{FY}/',
  delivery_challan: 'DC/{FY}/',
  receipt_voucher: 'RV/{FY}/',
  purchase_bill: 'PB/{FY}/',
  purchase_return: 'PR/{FY}/',
  expense: 'EXP/{FY}/',
  rcm_self_invoice: 'RCM/{FY}/',
};

/** Ledger account for each posting key: [code, name, type]. Created on demand for older businesses. */
const ACCOUNTS: Record<AccountKey, [string, string, string]> = {
  cash: ['1000', 'Cash', 'asset'],
  bank: ['1100', 'Bank', 'asset'],
  receivables: ['1200', 'Accounts Receivable', 'asset'],
  payables: ['2000', 'Accounts Payable', 'liability'],
  sales: ['4000', 'Sales', 'income'],
  purchases: ['5000', 'Purchases', 'expense'],
  expenses: ['5100', 'Expenses', 'expense'],
  roundOff: ['5200', 'Round-off', 'expense'],
  openingEquity: ['3100', 'Opening Balance Equity', 'equity'],
  tcsPayable: ['2200', 'TCS Payable', 'liability'],
  outputCgst: ['2100', 'Output GST', 'liability'],
  outputSgst: ['2100', 'Output GST', 'liability'],
  outputUtgst: ['2100', 'Output GST', 'liability'],
  outputIgst: ['2100', 'Output GST', 'liability'],
  outputCess: ['2100', 'Output GST', 'liability'],
  inputCgst: ['1300', 'Input GST', 'asset'],
  inputSgst: ['1300', 'Input GST', 'asset'],
  inputUtgst: ['1300', 'Input GST', 'asset'],
  inputIgst: ['1300', 'Input GST', 'asset'],
  inputCess: ['1300', 'Input GST', 'asset'],
};

export interface SaveDraftInput {
  /** Omit to create a new draft. */
  id?: string;
  /** Version the editor last saw, required with `id`. */
  version?: number;
  doc: NewRow;
  lines: NewRow[];
  /** The document this one was converted from. */
  sourceDocumentId?: string | null;
}

export interface SaveDraftResult extends DocumentWithLines {
  /** False when nothing differed from what was already stored. */
  changed: boolean;
}

export interface IssueOptions {
  /** Post stock movements for tracked items. */
  inventoryEnabled?: boolean;
}

export interface IssueResult {
  document: Row;
  /** The linked self-invoice created for a reverse-charge purchase bill. */
  selfInvoice: Row | null;
}

/** Stable text for a JSON value: object keys sorted, so Postgres reordering them changes nothing. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

const same = (a: unknown, b: unknown): boolean => {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (typeof x === 'object' && x !== null) return canonical(x) === canonical(y);
  // bigint columns may come back as strings on some drivers
  if (
    (typeof x === 'string' || typeof x === 'number') &&
    (typeof y === 'string' || typeof y === 'number')
  )
    return x === y || String(x) === String(y);
  return x === y;
};

const differs = (current: Row, next: NewRow): boolean =>
  Object.entries(next).some(([k, v]) => !same(current[k], v));

export class DocumentFlowRepo extends BaseRepo {
  private readonly docs: DocumentRepo;
  private readonly lineRepo: BaseRepo;
  private readonly ledger: BaseRepo;
  private readonly series: BaseRepo;
  private readonly movements: BaseRepo;
  private readonly accounts: BaseRepo;

  constructor(d: Database) {
    super(d, 'documents');
    this.docs = new DocumentRepo(d, consistencyValidator);
    this.lineRepo = new BaseRepo(d, 'document_lines');
    this.ledger = new BaseRepo(d, 'ledger_entries');
    this.series = new BaseRepo(d, 'number_series');
    this.movements = new BaseRepo(d, 'stock_movements');
    this.accounts = new BaseRepo(d, 'ledger_accounts');
  }

  private async currentLinesIn(tx: any, ctx: Ctx, documentId: string): Promise<Row[]> {
    const t = this.d.schema.document_lines;
    return tx
      .select()
      .from(t)
      .where(
        and(eq(t.document_id, documentId), eq(t.business_id, ctx.businessId), isNull(t.deleted_at)),
      )
      .orderBy(t.line_no);
  }

  /** Load a document with its lines. */
  async load(ctx: Ctx, id: string): Promise<DocumentWithLines | null> {
    return this.docs.getWithLines(ctx, id);
  }

  /**
   * Create a draft or update one. Only rows that differ are written, so an autosave of an unchanged
   * document writes nothing and a one-cell edit writes one line and the header.
   */
  async saveDraft(ctx: Ctx, input: SaveDraftInput): Promise<SaveDraftResult> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const lines = input.lines.map((l, i) => ({ ...l, line_no: i + 1 }));

      if (!input.id) {
        const errors = consistencyValidator({ ...input.doc, status: 'draft' }, lines as Row[]);
        if (errors.length > 0)
          throw new RuleError(`document totals rejected: ${errors.join('; ')}`);
        const created = await this.docs.createWithLines(
          c,
          { ...input.doc, status: 'draft', source_document_id: input.sourceDocumentId ?? null },
          lines,
        );
        return { ...created, changed: true };
      }

      const current = await this.getIn(tx, c, input.id);
      if (!current) throw new NotFoundError('documents', input.id);
      if (current['status'] !== 'draft') throw new RuleError('only draft documents can be edited');
      const errors = consistencyValidator({ ...current, ...input.doc }, lines as Row[]);
      if (errors.length > 0) throw new RuleError(`document totals rejected: ${errors.join('; ')}`);

      let changed = false;
      let document = current;
      if (differs(current, input.doc)) {
        document = await this.updateIn(
          tx,
          c,
          input.id,
          input.doc,
          input.version ?? current['version'],
        );
        changed = true;
      } else if (input.version !== undefined && input.version !== current['version']) {
        throw new ConflictError('documents', input.id, input.version);
      }

      const existing = await this.currentLinesIn(tx, c, input.id);
      const byNo = new Map(existing.map((l) => [Number(l['line_no']), l]));
      const out: Row[] = [];
      for (const l of lines) {
        const old = byNo.get(Number(l.line_no));
        byNo.delete(Number(l.line_no));
        if (!old) {
          out.push(await (this.lineRepo as any).createIn(tx, c, { ...l, document_id: input.id }));
          changed = true;
        } else if (differs(old, l)) {
          out.push(await (this.lineRepo as any).updateIn(tx, c, old['id'], l, old['version']));
          changed = true;
        } else out.push(old);
      }
      for (const extra of byNo.values()) {
        await this.lineRepo.softDelete(c, extra['id'], extra['version']);
        changed = true;
      }
      return { document, lines: out, changed };
    });
  }

  /** Drafts, most recently touched first. */
  async listDrafts(ctx: Ctx, limit = 50): Promise<Row[]> {
    return this.list(ctx, {
      where: eq(this.t.status, 'draft'),
      orderBy: desc(this.d.schema.documents.updated_at),
      limit,
    });
  }

  private async accountIdIn(tx: any, ctx: Ctx, key: AccountKey): Promise<string> {
    const [code, name, type] = ACCOUNTS[key];
    const t = this.d.schema.ledger_accounts;
    const [row]: Row[] = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), eq(t.code, code), isNull(t.deleted_at)))
      .limit(1);
    if (row) return row['id'];
    const made = await (this.accounts as any).createIn(tx, ctx, {
      code,
      name,
      type,
      is_system: true,
    });
    return made['id'];
  }

  /** The next number for a document type. The default series is created the first time it is needed. */
  private async takeNumberIn(
    tx: any,
    ctx: Ctx,
    type: string,
    date: string,
    fyStartMonth: number,
  ): Promise<{ number: string; seriesId: string }> {
    const t = this.d.schema.number_series;
    const all: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(eq(t.business_id, ctx.businessId), eq(t.document_type, type), isNull(t.deleted_at)),
      )
      .orderBy(t.created_at);
    const first = all[0];
    const label = fyOf(date, fyStartMonth).label;
    // one counter per financial year, so a back-dated invoice never reuses or disturbs a number
    const found =
      first?.['reset'] === 'never'
        ? first
        : (all.find((r) => r['fy'] === label) ?? all.find((r) => r['fy'] === null));
    const row: Row =
      found ??
      (await (this.series as any).createIn(tx, ctx, {
        document_type: type,
        prefix:
          first?.['prefix'] ?? DEFAULT_PREFIX[type] ?? `${type.slice(0, 3).toUpperCase()}/{FY}/`,
        suffix: first?.['suffix'] ?? '',
        padding: first?.['padding'] ?? 4,
        reset: first?.['reset'] ?? 'fy',
        fy: label,
        next_number: 1,
      }));
    const spec = {
      prefix: row['prefix'],
      suffix: row['suffix'],
      padding: row['padding'],
      reset: row['reset'],
    };
    let taken = takeNext(
      spec,
      { next: Number(row['next_number']), fy: (row['fy'] as string | null) ?? null },
      date,
      fyStartMonth,
    );
    // A number that is already on a document (imported history, an earlier series, numbers typed by
    // hand) is never reused: skip past it.
    const docs = this.d.schema.documents;
    for (let tries = 0; tries < 100_000; tries++) {
      const [clash]: Row[] = await tx
        .select({ id: docs.id })
        .from(docs)
        .where(
          and(
            eq(docs.business_id, ctx.businessId),
            eq(docs.type, type),
            eq(docs.number, taken.number),
          ),
        )
        .limit(1);
      if (!clash) break;
      taken = takeNext(spec, taken.state, date, fyStartMonth);
    }
    await (this.series as any).updateIn(
      tx,
      ctx,
      row['id'],
      { next_number: taken.state.next, fy: taken.state.fy },
      row['version'],
    );
    return { number: taken.number, seriesId: row['id'] };
  }

  /**
   * Issue a draft: give it its number, post the ledger, move stock and, for a reverse-charge
   * purchase bill, create the linked self-invoice. All or nothing.
   */
  async issueDraft(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    opts: IssueOptions = {},
  ): Promise<IssueResult> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const current = await this.getIn(tx, c, id);
      if (!current) throw new NotFoundError('documents', id);
      if (current['status'] !== 'draft') throw new RuleError('only draft documents can be issued');
      const type = String(current['type']) as DocumentType;

      const business = await new BusinessRepo(this.d).get(c);
      const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
      const check = canIssue(type, scheme);
      if (!check.ok) throw new RuleError(check.reason);
      const fyStart = Number(business?.['fy_start_month'] ?? 4);

      const lines = await this.currentLinesIn(tx, c, id);
      if (lines.length === 0) throw new RuleError('a blank document cannot be issued');
      const errors = consistencyValidator(current, lines);
      if (errors.length > 0) throw new RuleError(`document totals rejected: ${errors.join('; ')}`);

      const { number, seriesId } = await this.takeNumberIn(
        tx,
        c,
        type,
        String(current['date']),
        fyStart,
      );
      const issued = await this.updateIn(
        tx,
        c,
        id,
        { status: 'issued', number, series_id: seriesId },
        expectedVersion,
      );

      await this.postLedgerIn(tx, c, issued);
      if (opts.inventoryEnabled) await this.moveStockIn(tx, c, issued, lines);

      let selfInvoice: Row | null = null;
      if (type === 'purchase_bill' && current['reverse_charge']) {
        selfInvoice = await this.selfInvoiceIn(tx, c, issued, lines, fyStart);
      }
      return { document: issued, selfInvoice };
    });
  }

  private async postLedgerIn(tx: any, ctx: Ctx, doc: Row): Promise<void> {
    const type = doc['type'] as DocumentType;
    if (!POSTS_TO_LEDGER.has(type)) return;
    const n = (k: string) => BigInt(Number(doc[k] ?? 0));
    const entries = postDocument({
      type,
      status: 'issued',
      taxablePaise: n('total_taxable_paise'),
      cgstPaise: n('total_cgst_paise'),
      sgstPaise: n('total_sgst_paise'),
      utgstPaise: n('total_utgst_paise'),
      igstPaise: n('total_igst_paise'),
      cessPaise: n('total_cess_paise'),
      tcsPaise: n('tcs_paise'),
      roundOffPaise: n('round_off_paise'),
      totalPaise: n('total_paise'),
      reverseCharge: !!doc['reverse_charge'],
    });
    for (const e of entries) {
      await (this.ledger as any).createIn(tx, ctx, {
        document_id: doc['id'],
        party_id: e.account === 'receivables' || e.account === 'payables' ? doc['party_id'] : null,
        account_id: await this.accountIdIn(tx, ctx, e.account),
        debit_paise: Number(e.debitPaise),
        credit_paise: Number(e.creditPaise),
        date: doc['date'],
        narration: e.narration,
      });
    }
  }

  private async moveStockIn(tx: any, ctx: Ctx, doc: Row, lines: Row[]): Promise<void> {
    const effect = stockEffect(doc['type'] as DocumentType);
    if (!effect) return;
    const itemIds = [...new Set(lines.map((l) => l['item_id']).filter((x): x is string => !!x))];
    if (itemIds.length === 0) return;
    const items = this.d.schema.items;
    const tracked: Row[] = await tx
      .select({ id: items.id, track: items.track_stock })
      .from(items)
      .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
    const trackedIds = new Set(tracked.filter((i) => i['track']).map((i) => i['id']));
    const g = this.d.schema.godowns;
    const [godown]: Row[] = await tx
      .select({ id: g.id })
      .from(g)
      .where(and(eq(g.business_id, ctx.businessId), eq(g.is_default, true), isNull(g.deleted_at)))
      .limit(1);
    for (const l of lines) {
      if (!l['item_id'] || !trackedIds.has(l['item_id'])) continue;
      const qty = Number(l['qty_micros']);
      await (this.movements as any).createIn(tx, ctx, {
        item_id: l['item_id'],
        godown_id: godown?.['id'] ?? null,
        kind: effect,
        qty_micros: effect === 'out' ? -qty : qty,
        rate_paise: Number(l['rate_paise']),
        document_id: doc['id'],
        date: doc['date'],
        note: `${doc['type']} ${doc['number']}`,
      });
    }
  }

  /** The recipient's own invoice for tax it pays under reverse charge, linked to the supplier's bill. */
  private async selfInvoiceIn(
    tx: any,
    ctx: Ctx,
    bill: Row,
    lines: Row[],
    fyStart: number,
  ): Promise<Row> {
    const { number, seriesId } = await this.takeNumberIn(
      tx,
      ctx,
      'rcm_self_invoice',
      String(bill['date']),
      fyStart,
    );
    const strip = ({
      id: _id,
      org_id: _o,
      business_id: _b,
      version: _v,
      created_at: _c,
      updated_at: _u,
      created_by: _cb,
      updated_by: _ub,
      deleted_at: _d,
      ...rest
    }: Row) => rest;
    const meta = {
      ...((bill['metadata_json'] as object | null) ?? {}),
      selfInvoice: true,
      selfInvoiceOf: bill['id'],
    };
    const copy = await this.createIn(tx, ctx, {
      ...strip(bill),
      type: 'rcm_self_invoice',
      status: 'issued',
      number,
      series_id: seriesId,
      source_document_id: bill['id'],
      metadata_json: meta,
    });
    for (const l of lines) {
      await (this.lineRepo as any).createIn(tx, ctx, { ...strip(l), document_id: copy['id'] });
    }
    return copy;
  }

  /**
   * What a party has been invoiced, and what we have bought from it, in a date range (a financial
   * year). Feeds the TCS 206C(1H) and TDS 194Q threshold checks. Sales include GST (that is the base
   * for TCS); purchases are taxable value (the base for TDS). Credit notes and returns reduce them.
   */
  async fyTotals(
    ctx: Ctx,
    partyId: string,
    from: string,
    to: string,
    excludeId?: string,
  ): Promise<{ salesPaise: bigint; purchasesTaxablePaise: bigint }> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const rows: Row[] = await tx
        .select({
          id: t.id,
          type: t.type,
          total: t.total_paise,
          taxable: t.total_taxable_paise,
          date: t.date,
        })
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.party_id, partyId),
            eq(t.status, 'issued'),
            isNull(t.deleted_at),
            gte(t.date, from),
            lte(t.date, to),
          ),
        );
      let sales = 0n;
      let purchases = 0n;
      for (const r of rows) {
        if (r['id'] === excludeId) continue;
        const total = BigInt(Number(r['total']));
        const taxable = BigInt(Number(r['taxable']));
        switch (r['type']) {
          case 'tax_invoice':
          case 'bill_of_supply':
          case 'debit_note':
            sales += total;
            break;
          case 'credit_note':
            sales -= total;
            break;
          case 'purchase_bill':
            purchases += taxable;
            break;
          case 'purchase_return':
            purchases -= taxable;
            break;
        }
      }
      return {
        salesPaise: sales > 0n ? sales : 0n,
        purchasesTaxablePaise: purchases > 0n ? purchases : 0n,
      };
    });
  }

  /** Delete a draft (soft delete; issued documents are cancelled, never deleted). */
  async discardDraft(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return this.softDelete(ctx, id, expectedVersion);
  }
}
