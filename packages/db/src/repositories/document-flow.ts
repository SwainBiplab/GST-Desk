/**
 * The document editor's persistence: save a draft (touching only what changed), issue it
 * (number, ledger posting, stock, reverse-charge self-invoice in one transaction) and load or delete
 * drafts. Money is never computed here: rows arrive from `buildDocument` in `@gst/domain` and are
 * checked by `consistencyValidator` before they are written.
 */
import {
  POSTS_TO_LEDGER,
  canIssue,
  cancelBlocker,
  classifyEdit,
  formatDocumentNumber,
  fyOf,
  isProvisional,
  postDocument,
  provisionalNumber,
  stockEffectOf,
  takeNext,
  type AccountKey,
  type DocumentType,
} from '@gst/domain';
import { and, desc, eq, gte, isNull, lte, ne } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import { BusinessRepo, DocumentRepo, SettingsRepo, type DocumentWithLines } from './aggregates';
import {
  BaseRepo,
  ConflictError,
  NotFoundError,
  RuleError,
  newId,
  runInTx,
  type Ctx,
} from './base';
import { InsufficientStockError, checkIssueIn } from './inventory';
import { consistencyValidator } from './line-math';
import { NumberingRepo, type ShellName } from './numbering';
import { PeriodLockRepo, type LockOverride } from './period-lock';

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
export const ACCOUNTS: Record<AccountKey, [string, string, string]> = {
  cash: ['1000', 'Cash', 'asset'],
  bank: ['1100', 'Bank', 'asset'],
  receivables: ['1200', 'Accounts Receivable', 'asset'],
  payables: ['2000', 'Accounts Payable', 'liability'],
  sales: ['4000', 'Sales', 'income'],
  purchases: ['5000', 'Purchases', 'expense'],
  expenses: ['5100', 'Expenses', 'expense'],
  roundOff: ['5200', 'Round-off', 'expense'],
  adjustments: ['5300', 'Adjustments', 'expense'],
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
  /** Issue from this series (its `series_key`); otherwise the shell's default, then the type's default. */
  seriesKey?: string | null;
  shell?: ShellName;
  /** Needed (with an owner role) to issue a document dated inside a locked period. */
  lockOverride?: LockOverride;
}

export interface CancelOptions {
  /** Date of the reversing entries; defaults to today. */
  date?: string;
  lockOverride?: LockOverride;
}

export interface CancelResult {
  document: Row;
  /** Documents cancelled with it (a reverse-charge bill's self-invoice). */
  alsoCancelled: Row[];
  /** Payments that were applied to the document and are now unallocated, to warn about. */
  unallocated: { paymentId: string; documentId: string; amountPaise: number }[];
}

export interface ReviseOptions {
  inventoryEnabled?: boolean;
  lockOverride?: LockOverride;
}

export interface ReviseResult extends DocumentWithLines {
  changed: boolean;
  /** `financial` bumped the revision; `non_financial` did not; `none` wrote nothing. */
  kind: 'none' | 'non_financial' | 'financial';
  /** Payments now exceed what the document is worth. */
  overAllocatedPaise: number;
}

/**
 * One issue, cancel or revision at a time per database: the number a document takes and the ledger it
 * posts are decided in a single queue, so concurrent callers can never see the same counter value.
 */
const queues = new WeakMap<object, Promise<unknown>>();
export function serialised<T>(d: Database, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(d) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(
    d,
    run.catch(() => undefined),
  );
  return run;
}

const omit = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Header fields an edit changed, with the editor-only reference numbers told apart from the rest. */
function changedFields(current: Row, next: NewRow): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (k === 'metadata_json') {
      const a = (current[k] ?? {}) as Record<string, unknown>;
      const b = (v ?? {}) as Record<string, unknown>;
      const strip = (m: Record<string, unknown>) => omit(m, ['refs', 'seriesKey']);
      if (!same(strip(a), strip(b))) out.push(k);
      if (!same(a['refs'] ?? {}, b['refs'] ?? {})) out.push('reference');
    } else if (!same(current[k], v)) out.push(k);
  }
  return out;
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
  private readonly numbering: NumberingRepo;
  private readonly lock: PeriodLockRepo;
  private readonly allocations: BaseRepo;

  constructor(d: Database) {
    super(d, 'documents');
    this.numbering = new NumberingRepo(d);
    this.lock = new PeriodLockRepo(d);
    this.allocations = new BaseRepo(d, 'payment_allocations');
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

      const written = await this.writeLinesIn(tx, c, input.id, lines);
      if (written.changed) changed = true;
      return { document, lines: written.lines, changed };
    });
  }

  /** Write only the lines that differ from what is stored: new, changed, and removed ones. */
  private async writeLinesIn(
    tx: any,
    c: Ctx,
    documentId: string,
    lines: NewRow[],
  ): Promise<{ lines: Row[]; changed: boolean }> {
    let changed = false;
    const existing = await this.currentLinesIn(tx, c, documentId);
    const byNo = new Map(existing.map((l) => [Number(l['line_no']), l]));
    const out: Row[] = [];
    for (const l of lines) {
      const old = byNo.get(Number(l.line_no));
      byNo.delete(Number(l.line_no));
      if (!old) {
        out.push(await (this.lineRepo as any).createIn(tx, c, { ...l, document_id: documentId }));
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
    return { lines: out, changed };
  }

  /** Documents with this number (a number is unique per type, so a few at most). */
  async findByNumber(ctx: Ctx, number: string): Promise<Row[]> {
    return this.list(ctx, { where: eq(this.t.number, number) });
  }

  /** Drafts, most recently touched first. */
  async listDrafts(ctx: Ctx, limit = 50): Promise<Row[]> {
    return this.list(ctx, {
      where: eq(this.t.status, 'draft'),
      orderBy: desc(this.d.schema.documents.updated_at),
      limit,
    });
  }

  async accountIdIn(tx: any, ctx: Ctx, key: AccountKey): Promise<string> {
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

  /**
   * The next number for a document of `type` dated `date`, from the series the caller named, else the
   * shell's default, else the type's default series. Each series keeps a counter per financial year.
   * The default series is created the first time it is needed.
   */
  /**
   * The series and year counter a document of `type` on `date` takes its number from (the one named, else
   * the shell's or the type's default), made on first use. Shared by issuing and by the cloud handing out
   * number ranges, so a series is never made twice.
   */
  async counterIn(
    tx: any,
    ctx: Ctx,
    type: string,
    date: string,
    fyStartMonth: number,
    opts: { seriesKey?: string | null; shell?: ShellName } = {},
  ): Promise<Row> {
    const t = this.d.schema.number_series;
    const all: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(eq(t.business_id, ctx.businessId), eq(t.document_type, type), isNull(t.deleted_at)),
      )
      .orderBy(t.created_at);
    const groups = new Map<string, Row[]>();
    for (const r of all) {
      const k = (r['series_key'] as string | null) ?? `legacy-${type}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const list = [...groups.values()];
    let chosen: Row[] | undefined;
    if (opts.seriesKey) {
      chosen = groups.get(opts.seriesKey);
      if (!chosen) throw new RuleError('That number series no longer exists. Pick another.');
    } else {
      chosen =
        (opts.shell
          ? list.find((g) => g.some((r) => r['shell_default'] === opts.shell))
          : undefined) ??
        list.find((g) => g.some((r) => r['is_default'])) ??
        list[0];
    }
    const first = chosen?.[0];
    const label = fyOf(date, fyStartMonth).label;
    // one counter per financial year, so a back-dated invoice never reuses or disturbs a number
    const found =
      first?.['reset'] === 'never'
        ? first
        : (chosen?.find((r) => r['fy'] === label) ?? chosen?.find((r) => r['fy'] === null));
    const start = Number(first?.['start_number'] ?? 1);
    const row: Row =
      found ??
      (await (this.series as any).createIn(tx, ctx, {
        document_type: type,
        series_key:
          (first?.['series_key'] as string | null) ?? (first ? `legacy-${type}` : newId()),
        name: first?.['name'] ?? 'Default',
        is_default: first ? !!first['is_default'] : true,
        shell_default: first?.['shell_default'] ?? null,
        start_number: start,
        prefix:
          first?.['prefix'] ?? DEFAULT_PREFIX[type] ?? `${type.slice(0, 3).toUpperCase()}/{FY}/`,
        suffix: first?.['suffix'] ?? '',
        padding: first?.['padding'] ?? 4,
        reset: first?.['reset'] ?? 'fy',
        fy: label,
        next_number: start,
      }));
    return row;
  }

  /** Make sure the counter for a type and date exists; returns its series key. For the cloud's range handout. */
  async ensureCounter(
    ctx: Ctx,
    type: string,
    date: string,
  ): Promise<{ seriesKey: string; counterId: string }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const business = await new BusinessRepo(this.d).get(c);
      const row = await this.counterIn(
        tx,
        c,
        type,
        date,
        Number(business?.['fy_start_month'] ?? 4),
      );
      return {
        seriesKey: String(row['series_key'] ?? `legacy-${type}`),
        counterId: String(row['id']),
      };
    });
  }

  async takeNumberIn(
    tx: any,
    ctx: Ctx,
    type: string,
    date: string,
    fyStartMonth: number,
    opts: { seriesKey?: string | null; shell?: ShellName; forceCounter?: boolean } = {},
  ): Promise<{ number: string; seriesId: string }> {
    const row = await this.counterIn(tx, ctx, type, date, fyStartMonth, opts);
    const spec = {
      prefix: row['prefix'],
      suffix: row['suffix'],
      padding: row['padding'],
      reset: row['reset'],
    };

    // several devices: numbers come from this device's reserved range, or are provisional until one is given
    if (!opts.forceCounter && (await this.numbering.getMode(ctx)) === 'synced') {
      const range = await this.numbering.activeRangeIn(tx, ctx, row['id']);
      if (range) {
        const n = await this.numbering.consumeFromIn(tx, ctx, range);
        return { number: formatDocumentNumber(spec, n, date, fyStartMonth), seriesId: row['id'] };
      }
      return { number: await this.nextProvisionalIn(ctx), seriesId: row['id'] };
    }

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
   * `PROV-<device>-0001`, `PROV-<device>-0002`, ... for a device that has no range yet. Never reused. The
   * counter is kept per device (settings scope `device:<id>`), so two devices never make the same one.
   */
  private async nextProvisionalIn(ctx: Ctx): Promise<string> {
    const settings = new SettingsRepo(this.d);
    const scope = `device:${ctx.deviceId}`;
    const n = ((await settings.getValue<number>(ctx, 'provisional_counter', scope)) ?? 0) + 1;
    await settings.set(ctx, 'provisional_counter', n, scope);
    return provisionalNumber(n, ctx.deviceId.replace(/[^0-9a-f]/gi, '').slice(0, 8));
  }

  /**
   * Replace a provisional number with a real one from the series counter. The hook for prompt 41:
   * sync calls it once the device is connected to the authority that owns the counter.
   */
  async finaliseNumber(ctx: Ctx, id: string): Promise<Row> {
    return serialised(this.d, () =>
      runInTx(this.d, ctx, (tx) => this.finaliseNumberIn(tx, { ...ctx, tx }, id)),
    );
  }

  /** The same inside a transaction the caller holds (the cloud API's sync write path). */
  async finaliseNumberIn(tx: any, ctx: Ctx, id: string): Promise<Row> {
    {
      {
        const c: Ctx = { ...ctx, tx };
        const doc = await this.getIn(tx, c, id);
        if (!doc) throw new NotFoundError('documents', id);
        if (!isProvisional(doc['number'] as string | null)) return doc;
        const business = await new BusinessRepo(this.d).get(c);
        const fyStart = Number(business?.['fy_start_month'] ?? 4);
        const s = this.d.schema.number_series;
        const [counter]: Row[] = doc['series_id']
          ? await tx.select().from(s).where(eq(s.id, doc['series_id'])).limit(1)
          : [];
        const { number, seriesId } = await this.takeNumberIn(
          tx,
          c,
          String(doc['type']),
          String(doc['date']),
          fyStart,
          { seriesKey: (counter?.['series_key'] as string | null) ?? null, forceCounter: true },
        );
        return this.updateIn(tx, c, id, { number, series_id: seriesId }, doc['version']);
      }
    }
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
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const current = await this.getIn(tx, c, id);
        if (!current) throw new NotFoundError('documents', id);
        if (current['status'] !== 'draft')
          throw new RuleError('only draft documents can be issued');
        const type = String(current['type']) as DocumentType;
        await this.lock.assertOpen(
          c,
          String(current['date']),
          { action: 'issue', documentId: id },
          opts.lockOverride,
        );

        const business = await new BusinessRepo(this.d).get(c);
        const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
        const check = canIssue(type, scheme);
        if (!check.ok) throw new RuleError(check.reason);
        const fyStart = Number(business?.['fy_start_month'] ?? 4);

        const lines = await this.currentLinesIn(tx, c, id);
        if (lines.length === 0) throw new RuleError('a blank document cannot be issued');
        const errors = consistencyValidator(current, lines);
        if (errors.length > 0)
          throw new RuleError(`document totals rejected: ${errors.join('; ')}`);

        const picked = (current['metadata_json'] as { seriesKey?: string | null } | null)
          ?.seriesKey;
        const { number, seriesId } = await this.takeNumberIn(
          tx,
          c,
          type,
          String(current['date']),
          fyStart,
          {
            seriesKey: opts.seriesKey ?? picked ?? null,
            ...(opts.shell ? { shell: opts.shell } : {}),
          },
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
    // inside the caller's transaction the caller already holds the database
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /**
   * Issue a draft that came from another system under the number it already has. The number goes in a
   * separate series named "Imported" (made on first use, never the default, never a counter that moves),
   * the ledger is posted, and no stock moves: history does not change what is on the shelf now. Nothing
   * else about issuing is relaxed: a locked period, a blank document or wrong totals still stop it.
   */
  async issueImported(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    opts: { number: string; lockOverride?: LockOverride },
  ): Promise<IssueResult> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const current = await this.getIn(tx, c, id);
        if (!current) throw new NotFoundError('documents', id);
        if (current['status'] !== 'draft')
          throw new RuleError('only draft documents can be issued');
        const type = String(current['type']) as DocumentType;
        await this.lock.assertOpen(
          c,
          String(current['date']),
          { action: 'issue', documentId: id },
          opts.lockOverride,
        );
        const business = await new BusinessRepo(this.d).get(c);
        const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
        const check = canIssue(type, scheme);
        if (!check.ok) throw new RuleError(check.reason);
        const lines = await this.currentLinesIn(tx, c, id);
        if (lines.length === 0) throw new RuleError('a blank document cannot be issued');
        const errors = consistencyValidator(current, lines);
        if (errors.length > 0)
          throw new RuleError(`document totals rejected: ${errors.join('; ')}`);
        const number = opts.number.trim();
        if (!number) throw new RuleError('An imported document needs the number it already has.');
        const docs = this.d.schema.documents;
        const clash: Row[] = await tx
          .select({ id: docs.id })
          .from(docs)
          .where(
            and(
              eq(docs.business_id, c.businessId),
              eq(docs.type, type),
              eq(docs.number, number),
              ne(docs.status, 'draft'),
              isNull(docs.deleted_at),
            ),
          )
          .limit(1);
        if (clash.length > 0) throw new RuleError(`${number} is already used by another ${type}.`);
        const seriesId = await this.importedSeriesIn(tx, c, type);
        const issued = await this.updateIn(
          tx,
          c,
          id,
          { status: 'issued', number, series_id: seriesId },
          expectedVersion,
        );
        await this.postLedgerIn(tx, c, issued);
        return { document: issued, selfInvoice: null };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /** The "Imported" series of a document type, made when it is first needed. It is never the default. */
  private async importedSeriesIn(tx: any, ctx: Ctx, type: string): Promise<string> {
    const t = this.d.schema.number_series;
    const all: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(eq(t.business_id, ctx.businessId), eq(t.document_type, type), isNull(t.deleted_at)),
      );
    const have = all.find((r) => r['name'] === 'Imported');
    if (have) return have['id'] as string;
    // a type with no series yet gets its ordinary default first, so "Imported" can never be picked as one
    if (!all.some((r) => r['is_default'])) {
      await (this.series as any).createIn(tx, ctx, {
        document_type: type,
        series_key: newId(),
        name: 'Default',
        is_default: true,
        shell_default: null,
        start_number: 1,
        prefix: DEFAULT_PREFIX[type] ?? `${type.slice(0, 3).toUpperCase()}/{FY}/`,
        suffix: '',
        padding: 4,
        reset: 'fy',
        fy: null,
        next_number: 1,
      });
    }
    const row: Row = await (this.series as any).createIn(tx, ctx, {
      document_type: type,
      series_key: newId(),
      name: 'Imported',
      is_default: false,
      shell_default: null,
      start_number: 1,
      prefix: 'IMP/',
      suffix: '',
      padding: 4,
      reset: 'never',
      fy: null,
      next_number: 1,
    });
    return row['id'] as string;
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
    const meta = (doc['metadata_json'] ?? {}) as { reduceStock?: boolean | null };
    const effect = stockEffectOf(doc['type'] as DocumentType, meta);
    if (!effect) return;
    // an invoice made from a challan that already took the goods out does not take them out twice
    if (doc['source_document_id']) {
      const src = await this.getIn(tx, ctx, String(doc['source_document_id']));
      const srcMeta = (src?.['metadata_json'] ?? {}) as { reduceStock?: boolean | null };
      if (
        src &&
        src['type'] === 'delivery_challan' &&
        src['status'] === 'issued' &&
        srcMeta.reduceStock
      )
        return;
    }
    if (effect === 'out') {
      const { decision } = await checkIssueIn(
        this.d,
        tx,
        ctx,
        doc['type'] as DocumentType,
        lines.map((l) => ({
          itemId: l['item_id'] as string | null,
          qtyMicros: Number(l['qty_micros']),
        })),
        meta,
      );
      if (decision.action === 'block') throw new InsufficientStockError(decision.shortfalls);
    }
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

  /* ------------------------------------------------------------------ after issue */

  /**
   * Zero out what a document has posted to the ledger: one contra entry per account and party for
   * whatever net amount is still there. Works for a cancellation and for each revision, because it
   * reverses the running net, never the original rows twice.
   */
  private async reverseLedgerIn(
    tx: any,
    ctx: Ctx,
    doc: Row,
    date: string,
    narration: string,
  ): Promise<void> {
    const t = this.d.schema.ledger_entries;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.document_id, doc['id']),
          isNull(t.payment_id),
          isNull(t.deleted_at),
        ),
      );
    const net = new Map<string, { account: string; party: string | null; net: number }>();
    for (const r of rows) {
      const key = `${r['account_id']}|${r['party_id'] ?? ''}`;
      const cur = net.get(key) ?? {
        account: r['account_id'],
        party: (r['party_id'] as string | null) ?? null,
        net: 0,
      };
      cur.net += Number(r['debit_paise']) - Number(r['credit_paise']);
      net.set(key, cur);
    }
    for (const n of net.values()) {
      if (n.net === 0) continue;
      await (this.ledger as any).createIn(tx, ctx, {
        document_id: doc['id'],
        party_id: n.party,
        account_id: n.account,
        debit_paise: n.net < 0 ? -n.net : 0,
        credit_paise: n.net > 0 ? n.net : 0,
        date,
        narration,
      });
    }
  }

  /** Put back the stock a document moved: one opposite movement per item and godown for the net. */
  private async reverseStockIn(
    tx: any,
    ctx: Ctx,
    doc: Row,
    date: string,
    note: string,
  ): Promise<boolean> {
    const t = this.d.schema.stock_movements;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(eq(t.business_id, ctx.businessId), eq(t.document_id, doc['id']), isNull(t.deleted_at)),
      );
    const net = new Map<
      string,
      { item: string; godown: string | null; qty: number; rate: number }
    >();
    for (const r of rows) {
      const key = `${r['item_id']}|${r['godown_id'] ?? ''}`;
      const cur = net.get(key) ?? {
        item: r['item_id'],
        godown: (r['godown_id'] as string | null) ?? null,
        qty: 0,
        rate: Number(r['rate_paise'] ?? 0),
      };
      cur.qty += Number(r['qty_micros']);
      net.set(key, cur);
    }
    for (const n of net.values()) {
      if (n.qty === 0) continue;
      await (this.movements as any).createIn(tx, ctx, {
        item_id: n.item,
        godown_id: n.godown,
        kind: n.qty < 0 ? 'in' : 'out',
        qty_micros: -n.qty,
        rate_paise: n.rate,
        document_id: doc['id'],
        date,
        note,
      });
    }
    return rows.length > 0;
  }

  private async allocationsOfIn(tx: any, ctx: Ctx, documentId: string): Promise<Row[]> {
    const a = this.d.schema.payment_allocations;
    const rows: Row[] = await tx
      .select()
      .from(a)
      .where(and(eq(a.business_id, ctx.businessId), isNull(a.deleted_at)));
    return rows.filter(
      (r) => r['document_id'] === documentId || r['source_document_id'] === documentId,
    );
  }

  /**
   * Cancel an issued document. The number stays, the document leaves every total (its status is no
   * longer `issued`), the ledger and stock it posted are reversed with contra entries, and payments
   * applied to it are unallocated (they stay with the party as unapplied money). All in one
   * transaction: if any step fails the document is still issued.
   */
  async cancelDocument(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    reason: string,
    opts: CancelOptions = {},
  ): Promise<CancelResult> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const why = reason.trim();
        if (!why) throw new RuleError('Say why the document is being cancelled.');
        const alsoCancelled: Row[] = [];
        const unallocated: CancelResult['unallocated'] = [];
        const document = await this.cancelOneIn(tx, c, id, expectedVersion, why, opts, {
          alsoCancelled,
          unallocated,
        });
        return { document, alsoCancelled, unallocated };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /** The first filed return (GSTR-1 first) whose period covers `date`, or null. */
  private async filedReturnCoveringIn(
    tx: any,
    c: Ctx,
    date: string,
  ): Promise<{ returnType: string; fp: string } | null> {
    const f = this.d.schema.gst_filings;
    const rows: Row[] = await tx
      .select({ return_type: f.return_type, period_fp: f.period_fp })
      .from(f)
      .where(
        and(
          eq(f.business_id, c.businessId),
          eq(f.status, 'filed'),
          lte(f.period_from, date),
          gte(f.period_to, date),
          isNull(f.deleted_at),
        ),
      );
    if (rows.length === 0) return null;
    const first = rows.find((r) => r['return_type'] === 'gstr1') ?? rows[0]!;
    return { returnType: String(first['return_type']), fp: String(first['period_fp']) };
  }

  private async cancelOneIn(
    tx: any,
    c: Ctx,
    id: string,
    expectedVersion: number | null,
    why: string,
    opts: CancelOptions,
    out: Pick<CancelResult, 'alsoCancelled' | 'unallocated'>,
  ): Promise<Row> {
    const current = await this.getIn(tx, c, id);
    if (!current) throw new NotFoundError('documents', id);
    // an IRN blocks cancelling the document until the IRN itself has been cancelled on the portal
    const irnCancelled = current['irn']
      ? (
          await tx
            .select({ id: this.d.schema.einvoices.id })
            .from(this.d.schema.einvoices)
            .where(
              and(
                eq(this.d.schema.einvoices.business_id, c.businessId),
                eq(this.d.schema.einvoices.document_id, id),
                eq(this.d.schema.einvoices.status, 'cancelled'),
                isNull(this.d.schema.einvoices.deleted_at),
              ),
            )
        ).length > 0
      : false;
    const blocker = cancelBlocker({
      status: String(current['status']),
      hasIrn: !!current['irn'] && !irnCancelled,
    });
    if (blocker) throw new RuleError(blocker);
    // once a return that covers the document's date has been filed, the number has been reported to
    // the GST portal: the document cannot be cancelled, only corrected by a credit note (s.34)
    const filed = await this.filedReturnCoveringIn(tx, c, String(current['date']));
    if (filed)
      throw new RuleError(
        `${filed.returnType.toUpperCase()} for period ${filed.fp} has been filed with this document in it. A filed document cannot be cancelled; issue a credit note against it instead.`,
      );
    await this.lock.assertOpen(
      c,
      String(current['date']),
      { action: 'cancel', documentId: id },
      opts.lockOverride,
    );
    const on = opts.date ?? new Date().toISOString().slice(0, 10);
    const label = `Cancelled ${current['number'] ?? ''}: ${why}`.trim();

    const cancelled = await this.updateIn(
      tx,
      c,
      id,
      { status: 'cancelled', cancelled_at: Date.now(), cancel_reason: why },
      expectedVersion ?? current['version'],
    );
    await this.reverseLedgerIn(tx, c, current, on, label);
    await this.reverseStockIn(tx, c, current, on, label);

    for (const a of await this.allocationsOfIn(tx, c, id)) {
      await this.allocations.softDelete(c, a['id'], a['version']);
      if (a['kind'] === 'payment')
        out.unallocated.push({
          paymentId: a['payment_id'],
          documentId: a['document_id'],
          amountPaise: Number(a['amount_paise']),
        });
    }

    // a reverse-charge bill's self-invoice cannot outlive it
    const docs = this.d.schema.documents;
    const linked: Row[] = await tx
      .select()
      .from(docs)
      .where(
        and(
          eq(docs.business_id, c.businessId),
          eq(docs.source_document_id, id),
          eq(docs.type, 'rcm_self_invoice'),
          eq(docs.status, 'issued'),
          isNull(docs.deleted_at),
        ),
      );
    for (const l of linked) {
      out.alsoCancelled.push(
        await this.cancelOneIn(
          tx,
          c,
          l['id'],
          null,
          `Cancelled with ${current['number']}`,
          opts,
          out,
        ),
      );
    }
    return cancelled;
  }

  /**
   * Edit notes, terms, reference numbers or the due date of an issued document. Allowed at any time,
   * even in a locked period, because nothing financial changes. The audit log keeps before and after.
   */
  async editIssuedNotes(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    patch: {
      notes?: string | null;
      terms?: string | null;
      dueDate?: string | null;
      reference?: Record<string, string>;
    },
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const current = await this.getIn(tx, c, id);
      if (!current) throw new NotFoundError('documents', id);
      if (current['status'] !== 'issued')
        throw new RuleError('Only an issued document can be edited this way.');
      const next: NewRow = {};
      if (patch.notes !== undefined) next['notes'] = patch.notes;
      if (patch.terms !== undefined) next['terms'] = patch.terms;
      if (patch.dueDate !== undefined) next['due_date'] = patch.dueDate;
      if (patch.reference !== undefined)
        next['metadata_json'] = {
          ...((current['metadata_json'] as Record<string, unknown> | null) ?? {}),
          refs: patch.reference,
        };
      if (changedFields(current, next).length === 0) return current;
      return this.updateIn(tx, c, id, next, expectedVersion);
    });
  }

  /**
   * Save changes to an issued document from the editor. Notes, terms and references go straight
   * through. Anything financial needs an open period and a document that is not e-invoiced; it
   * rewrites the lines, reverses and reposts the ledger and stock, and bumps `revision`. The number,
   * type and status never change.
   */
  async reviseIssued(
    ctx: Ctx,
    input: { id: string; version: number; doc: NewRow; lines: NewRow[] },
    opts: ReviseOptions = {},
  ): Promise<ReviseResult> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const current = await this.getIn(tx, c, input.id);
        if (!current) throw new NotFoundError('documents', input.id);
        if (current['status'] !== 'issued')
          throw new RuleError('Only an issued document can be revised.');
        const lines = input.lines.map((l, i) => ({ ...l, line_no: i + 1 }));
        // number, type, status and series are not the editor's to change
        const doc = omit(input.doc as Record<string, unknown>, [
          'number',
          'type',
          'status',
          'series_id',
          'revision',
          'cancelled_at',
          'cancel_reason',
        ]);
        const fields = changedFields(current, doc as NewRow);

        const existing = await this.currentLinesIn(tx, c, input.id);
        const linesDiffer =
          existing.length !== lines.length ||
          lines.some((l, i) => {
            const old = existing.find((x) => Number(x['line_no']) === i + 1);
            return !old || differs(old, l as NewRow);
          });
        const kind =
          fields.length === 0 && !linesDiffer
            ? 'none'
            : linesDiffer
              ? 'financial'
              : classifyEdit(fields);
        if (kind === 'none') {
          return {
            document: current,
            lines: existing,
            changed: false,
            kind,
            overAllocatedPaise: 0,
          } as ReviseResult;
        }

        if (kind === 'non_financial') {
          const document = await this.updateIn(tx, c, input.id, doc as NewRow, input.version);
          return {
            document,
            lines: existing,
            changed: true,
            kind,
            overAllocatedPaise: 0,
          } as ReviseResult;
        }

        // financial
        if (current['irn'])
          throw new RuleError(
            'An e-invoiced document cannot be changed. Cancel it on the portal or issue a credit note.',
          );
        if (
          current['type'] === 'rcm_self_invoice' ||
          (current['type'] === 'purchase_bill' && current['reverse_charge'])
        )
          throw new RuleError(
            'A reverse-charge bill and its self-invoice cannot be edited after issue. Cancel it and enter it again.',
          );
        const newDate = String((doc as Record<string, unknown>)['date'] ?? current['date']);
        const business = await new BusinessRepo(this.d).get(c);
        const fyStart = Number(business?.['fy_start_month'] ?? 4);
        if (fyOf(newDate, fyStart).label !== fyOf(String(current['date']), fyStart).label)
          throw new RuleError(
            'The date cannot move to another financial year; its number belongs to the year it was issued in.',
          );
        for (const date of new Set([String(current['date']), newDate])) {
          await this.lock.assertOpen(
            c,
            date,
            { action: 'revise', documentId: input.id },
            opts.lockOverride,
          );
        }
        const errors = consistencyValidator({ ...current, ...(doc as NewRow) }, lines as Row[]);
        if (errors.length > 0)
          throw new RuleError(`document totals rejected: ${errors.join('; ')}`);

        const on = String(current['date']);
        const revision = Number(current['revision'] ?? 1) + 1;
        const document = await this.updateIn(
          tx,
          c,
          input.id,
          { ...(doc as NewRow), revision },
          input.version,
        );
        const written = await this.writeLinesIn(tx, c, input.id, lines);
        await this.reverseLedgerIn(tx, c, current, on, `Revision ${revision}: reversal`);
        await this.postLedgerIn(tx, c, document);
        const hadStock = await this.reverseStockIn(tx, c, current, on, `Revision ${revision}`);
        if (hadStock || opts.inventoryEnabled)
          await this.moveStockIn(tx, c, document, written.lines);

        let allocated = 0;
        for (const a of await this.allocationsOfIn(tx, c, input.id)) {
          if (a['document_id'] === input.id) allocated += Number(a['amount_paise']);
        }
        const overAllocatedPaise = Math.max(0, allocated - Number(document['total_paise']));
        return { document, lines: written.lines, changed: true, kind, overAllocatedPaise };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /** Delete a draft (soft delete; issued documents are cancelled, never deleted). */
  async discardDraft(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return this.softDelete(ctx, id, expectedVersion);
  }
}
