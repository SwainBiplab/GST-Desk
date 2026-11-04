import { DEFAULT_UNIT_CODES, canIssue, uqcName, type DocumentType } from '@gst/domain';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import {
  BaseRepo,
  ConflictError,
  NotFoundError,
  RuleError,
  ftsIds,
  newId,
  runInTx,
  writeAudit,
  type Ctx,
} from './base';
import { arithmeticValidator, type LineValidator } from './line-math';

/* ------------------------------------------------------------------ organisations & users */

export async function createOrganisation(
  d: Database,
  name: string,
  opts: { id?: string; tx?: any } = {},
): Promise<Row> {
  const now = Date.now();
  const [row] = await (opts.tx ?? d.db)
    .insert(d.schema.organisations)
    .values({ id: opts.id ?? newId(), name, created_at: now, updated_at: now })
    .returning();
  return row;
}

export async function createUser(
  d: Database,
  v: { email: string; name: string; phone?: string; locale?: string },
): Promise<Row> {
  const now = Date.now();
  const [row] = await d.db
    .insert(d.schema.users)
    .values({ id: newId(), created_at: now, updated_at: now, ...v })
    .returning();
  return row;
}

/** All live businesses (optionally of one organisation), oldest first. */
export async function listBusinesses(d: Database, orgId?: string): Promise<Row[]> {
  const t = d.schema.businesses;
  const query = (db: any) =>
    db
      .select()
      .from(t)
      .where(and(isNull(t.deleted_at), orgId ? eq(t.org_id, orgId) : undefined))
      .orderBy(t.created_at);
  if (d.dialect === 'pg') {
    // row-level security needs an organisation to scope to
    if (!orgId) throw new RuleError('orgId is required to list businesses on Postgres');
    return runInTx(
      d,
      { orgId, businessId: '', actor: 'system', deviceId: 'system' },
      async (tx) => query(tx),
      {
        allowNoBusiness: true,
      },
    );
  }
  return query(d.db);
}

/* ------------------------------------------------------------------ business */

const CHART = [
  ['1000', 'Cash', 'asset'],
  ['1100', 'Bank', 'asset'],
  ['1200', 'Accounts Receivable', 'asset'],
  ['1300', 'Input GST', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['2100', 'Output GST', 'liability'],
  ['2200', 'TCS Payable', 'liability'],
  ['3000', 'Owner Equity', 'equity'],
  ['3100', 'Opening Balance Equity', 'equity'],
  ['4000', 'Sales', 'income'],
  ['5000', 'Purchases', 'expense'],
  ['5100', 'Expenses', 'expense'],
  ['5200', 'Round-off', 'expense'],
] as const;

export class BusinessRepo {
  constructor(private readonly d: Database) {}

  /** `ctx.businessId` is ignored on create; the new business id is returned in the row. */
  async create(ctx: Ctx, values: NewRow, opts: { withDefaults?: boolean } = {}): Promise<Row> {
    const id = values['id'] ?? newId();
    const bctx: Ctx = { ...ctx, businessId: id };
    return runInTx(
      this.d,
      ctx,
      async (tx) => {
        const now = Date.now();
        const [row] = await tx
          .insert(this.d.schema.businesses)
          .values({
            ...values,
            id,
            org_id: ctx.orgId,
            version: 1,
            created_at: now,
            updated_at: now,
            created_by: ctx.actor,
            updated_by: ctx.actor,
          })
          .returning();
        await writeAudit(this.d, tx, bctx, 'businesses', id, 'insert', null, row);
        if (opts.withDefaults !== false) await this.seedDefaults(tx, bctx);
        return row;
      },
      { allowNoBusiness: true },
    );
  }

  /** Archive (soft delete). The last live business of an organisation cannot be archived. */
  async archive(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.businesses;
      const live: Row[] = await tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.org_id, ctx.orgId), isNull(t.deleted_at)));
      if (live.length <= 1) throw new RuleError('the last business cannot be archived');
      const [before] = await tx
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.org_id, ctx.orgId), isNull(t.deleted_at)))
        .limit(1);
      if (!before) throw new NotFoundError('businesses', id);
      const now = Date.now();
      const [after] = await tx
        .update(t)
        .set({
          deleted_at: now,
          version: sql`${t.version} + 1`,
          updated_at: now,
          updated_by: ctx.actor,
        })
        .where(and(eq(t.id, id), eq(t.version, expectedVersion), isNull(t.deleted_at)))
        .returning();
      if (!after) throw new ConflictError('businesses', id, expectedVersion);
      await writeAudit(
        this.d,
        tx,
        { ...ctx, businessId: id },
        'businesses',
        id,
        'soft_delete',
        before,
        after,
      );
      return after;
    });
  }

  private async seedDefaults(tx: any, ctx: Ctx) {
    const s = this.d.schema;
    const base = (extra: Row) => ({
      id: newId(),
      org_id: ctx.orgId,
      business_id: ctx.businessId,
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: ctx.actor,
      updated_by: ctx.actor,
      ...extra,
    });
    await tx
      .insert(s.units)
      .values(DEFAULT_UNIT_CODES.map((code) => base({ code, name: uqcName(code)!, uqc: code })));
    await tx
      .insert(s.ledger_accounts)
      .values(CHART.map(([code, name, type]) => base({ code, name, type, is_system: true })));
    await tx.insert(s.godowns).values(base({ name: 'Main', is_default: true }));
  }

  async get(ctx: Ctx, id = ctx.businessId): Promise<Row | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.businesses;
      const rows = await tx
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deleted_at)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async update(ctx: Ctx, patch: NewRow, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.businesses;
      const before = await this.get({ ...ctx, tx }, ctx.businessId);
      if (!before) throw new NotFoundError('businesses', ctx.businessId);
      const clean = Object.fromEntries(
        Object.entries(patch).filter(([k]) => !['id', 'org_id', 'version'].includes(k)),
      );
      const [after] = await tx
        .update(t)
        .set({
          ...clean,
          version: sql`${t.version} + 1`,
          updated_at: Date.now(),
          updated_by: ctx.actor,
        })
        .where(and(eq(t.id, ctx.businessId), eq(t.version, expectedVersion), isNull(t.deleted_at)))
        .returning();
      if (!after) throw new ConflictError('businesses', ctx.businessId, expectedVersion);
      await writeAudit(this.d, tx, ctx, 'businesses', ctx.businessId, 'update', before, after);
      return after;
    });
  }
}

/* ------------------------------------------------------------------ parties & items */

export { PartyRepo } from './parties';

export { ItemRepo, UnitRepo, ImportMappingRepo } from './items';

/* ------------------------------------------------------------------ documents */

export interface DocumentWithLines {
  document: Row;
  lines: Row[];
}

export class DocumentRepo extends BaseRepo {
  private readonly lineRepo: BaseRepo;

  /** `validator` recomputes money from the domain engine; defaults to the built-in arithmetic. */
  constructor(
    d: Database,
    private readonly validator: LineValidator = arithmeticValidator,
  ) {
    super(d, 'documents');
    this.lineRepo = new BaseRepo(d, 'document_lines');
  }

  private check(doc: Row, lines: Row[]) {
    const errors = this.validator(doc, lines);
    if (errors.length > 0) throw new RuleError(`document totals rejected: ${errors.join('; ')}`);
  }

  private async insertLines(tx: any, ctx: Ctx, documentId: string, lines: NewRow[]) {
    const out: Row[] = [];
    for (const [i, l] of lines.entries()) {
      out.push(
        await (this.lineRepo as any).createIn(tx, ctx, {
          ...l,
          document_id: documentId,
          line_no: i + 1,
        }),
      );
    }
    return out;
  }

  private async linesOf(tx: any, ctx: Ctx, documentId: string): Promise<Row[]> {
    const t = this.d.schema.document_lines;
    return tx
      .select()
      .from(t)
      .where(
        and(eq(t.document_id, documentId), eq(t.business_id, ctx.businessId), isNull(t.deleted_at)),
      )
      .orderBy(t.line_no);
  }

  /** Hard block (CGST s.10): a composition business cannot create or issue tax invoices. */
  private async assertCanIssue(tx: any, ctx: Ctx, type: string): Promise<void> {
    const business = await new BusinessRepo(this.d).get({ ...ctx, tx });
    const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
    const check = canIssue(type as DocumentType, scheme);
    if (!check.ok) throw new RuleError(check.reason);
  }

  /** Create a document and its lines atomically. Totals must match recomputation. */
  async createWithLines(ctx: Ctx, doc: NewRow, lines: NewRow[]): Promise<DocumentWithLines> {
    this.check(doc, lines);
    if (doc['status'] && doc['status'] !== 'draft' && !doc['number']) {
      throw new RuleError('issued documents need a number');
    }
    return runInTx(this.d, ctx, async (tx) => {
      await this.assertCanIssue(tx, ctx, String(doc['type']));
      const document = await this.createIn(tx, ctx, doc);
      return { document, lines: await this.insertLines(tx, ctx, document['id'], lines) };
    });
  }

  async getWithLines(ctx: Ctx, id: string): Promise<DocumentWithLines | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const document = await this.getIn(tx, ctx, id);
      return document ? { document, lines: await this.linesOf(tx, ctx, id) } : null;
    });
  }

  /** Edit a draft. When `lines` is given the old lines are soft-deleted and replaced. */
  async updateDraft(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    patch: NewRow,
    lines?: NewRow[],
  ): Promise<DocumentWithLines> {
    return runInTx(this.d, ctx, async (tx) => {
      const current = await this.getIn(tx, ctx, id);
      if (!current) throw new NotFoundError('documents', id);
      if (current['status'] !== 'draft') throw new RuleError('only draft documents can be edited');
      const merged = { ...current, ...patch };
      const nextLines = lines ?? (await this.linesOf(tx, ctx, id));
      this.check(merged, nextLines);
      const document = await this.updateIn(tx, ctx, id, patch, expectedVersion);
      if (lines) {
        for (const old of await this.linesOf(tx, ctx, id)) {
          await this.lineRepo.softDelete({ ...ctx, tx }, old['id'], old['version']);
        }
        return { document, lines: await this.insertLines(tx, ctx, id, lines) };
      }
      return { document, lines: nextLines };
    });
  }

  /** draft -> issued with a number. The unique index rejects duplicate numbers per type. */
  async issue(ctx: Ctx, id: string, expectedVersion: number, number: string, seriesId?: string) {
    return runInTx(this.d, ctx, async (tx) => {
      const current = await this.getIn(tx, ctx, id);
      if (!current) throw new NotFoundError('documents', id);
      if (current['status'] !== 'draft') throw new RuleError('only draft documents can be issued');
      await this.assertCanIssue(tx, ctx, String(current['type']));
      return this.updateIn(
        tx,
        ctx,
        id,
        { status: 'issued', number, ...(seriesId ? { series_id: seriesId } : {}) },
        expectedVersion,
      );
    });
  }

  /** issued -> cancelled. The number is kept; documents are never deleted. */
  async cancel(ctx: Ctx, id: string, expectedVersion: number, reason: string) {
    if (!reason.trim()) throw new RuleError('a cancellation reason is required');
    return runInTx(this.d, ctx, async (tx) => {
      const current = await this.getIn(tx, ctx, id);
      if (!current) throw new NotFoundError('documents', id);
      if (current['status'] !== 'issued')
        throw new RuleError('only issued documents can be cancelled');
      return this.updateIn(
        tx,
        ctx,
        id,
        { status: 'cancelled', cancelled_at: Date.now(), cancel_reason: reason },
        expectedVersion,
      );
    });
  }

  protected override async beforeSoftDelete(_ctx: Ctx, _tx: any, row: Row) {
    if (row['status'] !== 'draft') throw new RuleError('only draft documents can be deleted');
  }

  async listBy(
    ctx: Ctx,
    f: {
      type?: string;
      status?: string;
      partyId?: string;
      from?: string;
      to?: string;
      limit?: number;
    },
  ) {
    const t = this.t;
    const conds = [
      f.type ? eq(t.type, f.type) : undefined,
      f.status ? eq(t.status, f.status) : undefined,
      f.partyId ? eq(t.party_id, f.partyId) : undefined,
      f.from ? gte(t.date, f.from) : undefined,
      f.to ? lte(t.date, f.to) : undefined,
    ];
    return this.list(ctx, {
      where: and(...conds),
      orderBy: desc(t.date),
      ...(f.limit !== undefined ? { limit: f.limit } : {}),
    });
  }

  async search(ctx: Ctx, q: string, limit = 20): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      this.byIds(tx, ctx, await ftsIds(this.d, tx, ctx, 'documents', q, limit)),
    );
  }
}

/* ------------------------------------------------------------------ payments */

export class PaymentRepo extends BaseRepo {
  private readonly allocRepo: BaseRepo;

  constructor(d: Database) {
    super(d, 'payments');
    this.allocRepo = new BaseRepo(d, 'payment_allocations');
  }

  /** Record a payment and allocate it to documents. Allocations of kind `payment` cannot exceed the amount. */
  async record(ctx: Ctx, payment: NewRow, allocations: NewRow[] = []) {
    const allocated = allocations
      .filter((a) => (a['kind'] ?? 'payment') === 'payment')
      .reduce((s, a) => s + Number(a['amount_paise']), 0);
    if (allocated > Number(payment['amount_paise'])) {
      throw new RuleError('allocations exceed the payment amount');
    }
    return runInTx(this.d, ctx, async (tx) => {
      const docs = this.d.schema.documents;
      for (const a of allocations) {
        const rows = await tx
          .select({ id: docs.id })
          .from(docs)
          .where(and(eq(docs.id, a['document_id']), eq(docs.business_id, ctx.businessId)))
          .limit(1);
        if (rows.length === 0) throw new NotFoundError('documents', String(a['document_id']));
      }
      const created = await this.createIn(tx, ctx, payment);
      const rows: Row[] = [];
      for (const a of allocations) {
        rows.push(
          await (this.allocRepo as any).createIn(tx, ctx, { ...a, payment_id: created['id'] }),
        );
      }
      return { payment: created, allocations: rows };
    });
  }

  async allocationsFor(ctx: Ctx, paymentId: string): Promise<Row[]> {
    return this.allocRepo.list(ctx, {
      where: eq(this.d.schema.payment_allocations.payment_id, paymentId),
    });
  }
}

/* ------------------------------------------------------------------ ledger */

export class LedgerRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'ledger_entries');
  }

  /** Post a balanced set of entries. Each entry carries exactly one of debit / credit. */
  async post(ctx: Ctx, entries: NewRow[]): Promise<Row[]> {
    let debit = 0;
    let credit = 0;
    for (const e of entries) {
      const dr = Number(e['debit_paise'] ?? 0);
      const cr = Number(e['credit_paise'] ?? 0);
      if (dr > 0 === cr > 0)
        throw new RuleError('each ledger entry needs exactly one of debit or credit');
      debit += dr;
      credit += cr;
    }
    if (debit !== credit)
      throw new RuleError(`unbalanced entries: debit ${debit} != credit ${credit}`);
    return runInTx(this.d, ctx, async (tx) => {
      const out: Row[] = [];
      for (const e of entries) out.push(await this.createIn(tx, ctx, e));
      return out;
    });
  }

  async trialBalance(ctx: Ctx, range: { from?: string; to?: string } = {}) {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const rows: Row[] = await tx
        .select({
          account_id: t.account_id,
          debit: sql<number>`sum(${t.debit_paise})`,
          credit: sql<number>`sum(${t.credit_paise})`,
        })
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            isNull(t.deleted_at),
            range.from ? gte(t.date, range.from) : undefined,
            range.to ? lte(t.date, range.to) : undefined,
          ),
        )
        .groupBy(t.account_id);
      return rows.map((r) => ({
        account_id: r['account_id'] as string,
        debit_paise: Number(r['debit']),
        credit_paise: Number(r['credit']),
      }));
    });
  }
}

/* ------------------------------------------------------------------ review, audit, settings */

export class ReviewRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'review_items');
  }

  pending(ctx: Ctx) {
    return this.list(ctx, { where: eq(this.t.status, 'pending') });
  }

  /** `correction` records what the user changed before accepting (for evals). */
  accept(ctx: Ctx, id: string, expectedVersion: number, correction?: unknown) {
    return this.update(
      ctx,
      id,
      {
        status: 'accepted',
        accepted_by: ctx.actor,
        accepted_at: Date.now(),
        ...(correction !== undefined ? { correction_json: correction } : {}),
      },
      expectedVersion,
    );
  }

  reject(ctx: Ctx, id: string, expectedVersion: number) {
    return this.update(ctx, id, { status: 'rejected' }, expectedVersion);
  }
}

export class AuditRepo {
  constructor(private readonly d: Database) {}

  forRow(ctx: Ctx, table: string, rowId: string): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.audit_log;
      return tx
        .select()
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), eq(t.table_name, table), eq(t.row_id, rowId)))
        .orderBy(t.at, t.created_at);
    });
  }

  recent(ctx: Ctx, limit = 100): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.audit_log;
      return tx
        .select()
        .from(t)
        .where(eq(t.business_id, ctx.businessId))
        .orderBy(desc(t.at))
        .limit(limit);
    });
  }
}

export class SettingsRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'settings');
  }

  private find(tx: any, ctx: Ctx, key: string, scope: string) {
    const t = this.t;
    return tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.key, key),
          eq(t.scope, scope),
          isNull(t.deleted_at),
        ),
      )
      .limit(1)
      .then((r: Row[]) => r[0] ?? null);
  }

  async getValue<T = unknown>(ctx: Ctx, key: string, scope = 'business'): Promise<T | undefined> {
    return runInTx(
      this.d,
      ctx,
      async (tx) => (await this.find(tx, ctx, key, scope))?.['value_json'],
    );
  }

  /** Upsert. Pass `expectedVersion` to guard against concurrent edits of an existing key. */
  async set(ctx: Ctx, key: string, value: unknown, scope = 'business', expectedVersion?: number) {
    return runInTx(this.d, ctx, async (tx) => {
      const existing = await this.find(tx, ctx, key, scope);
      if (!existing) return this.createIn(tx, ctx, { key, scope, value_json: value });
      return this.updateIn(
        tx,
        ctx,
        existing['id'],
        { value_json: value },
        expectedVersion ?? existing['version'],
      );
    });
  }
}

/* ------------------------------------------------------------------ attachments */

/** File metadata (name, type, size, sha256, where the bytes live). Bytes never go in a row. */
export class AttachmentRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'attachments');
  }

  /** Register a stored file. Re-uploading identical bytes for the same owner returns the existing row. */
  async register(
    ctx: Ctx,
    file: {
      ownerTable: string;
      ownerId: string;
      fileName: string;
      mime: string;
      sizeBytes: number;
      sha256: string;
      storagePath: string;
    },
  ): Promise<Row> {
    if (!/^[0-9a-f]{64}$/.test(file.sha256))
      throw new RuleError('sha256 must be 64 hex characters');
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const [existing] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.owner_table, file.ownerTable),
            eq(t.owner_id, file.ownerId),
            eq(t.sha256, file.sha256),
            isNull(t.deleted_at),
          ),
        )
        .limit(1);
      if (existing) return existing;
      return this.createIn(tx, ctx, {
        owner_table: file.ownerTable,
        owner_id: file.ownerId,
        file_name: file.fileName,
        mime: file.mime,
        size_bytes: file.sizeBytes,
        sha256: file.sha256,
        storage_path: file.storagePath,
      });
    });
  }

  forOwner(ctx: Ctx, ownerTable: string, ownerId: string): Promise<Row[]> {
    return this.list(ctx, {
      where: and(eq(this.t.owner_table, ownerTable), eq(this.t.owner_id, ownerId)),
    });
  }
}
