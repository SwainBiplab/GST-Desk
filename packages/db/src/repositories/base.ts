import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { NewRow, Row, TableName } from '../schema';

/** Passed to every repository method. `orgId` is required for Postgres row-level security. */
export interface Ctx {
  orgId: string;
  businessId: string;
  actor: string;
  deviceId: string;
  /** Existing transaction, set by `runInTx`. Repositories open their own when absent. */
  tx?: any;
}

export class ConflictError extends Error {
  override name = 'ConflictError';
  constructor(table: string, id: string, expectedVersion: number) {
    super(`${table} ${id} was modified (expected version ${expectedVersion})`);
  }
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(table: string, id: string) {
    super(`${table} ${id} not found`);
  }
}

/** A business rule was violated (e.g. soft-delete of a referenced party). */
export class RuleError extends Error {
  override name = 'RuleError';
}

const PROTECTED = new Set([
  'id',
  'org_id',
  'business_id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'deleted_at',
]);

/**
 * Run `fn` in a transaction scoped to the tenant. On Postgres this sets `app.org_id`
 * (transaction-local) so row-level security applies. Reuses `ctx.tx` when present.
 */
export async function runInTx<T>(d: Database, ctx: Ctx, fn: (tx: any) => Promise<T>): Promise<T> {
  if (ctx.tx) return fn(ctx.tx);
  return d.db.transaction(async (tx: any) => {
    if (d.dialect === 'pg')
      await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.orgId}, true)`);
    return fn(tx);
  });
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Append an `audit_log` row inside the caller's transaction. */
export async function writeAudit(
  d: Database,
  tx: any,
  ctx: Ctx,
  table: string,
  rowId: string,
  action: 'insert' | 'update' | 'soft_delete',
  before: Row | null,
  after: Row | null,
): Promise<void> {
  const now = Date.now();
  await tx.insert(d.schema.audit_log).values({
    id: newId(),
    org_id: ctx.orgId,
    business_id: ctx.businessId,
    created_at: now,
    table_name: table,
    row_id: rowId,
    action,
    before_json: before,
    after_json: after,
    actor: ctx.actor,
    device_id: ctx.deviceId,
    at: now,
  });
}

/** Tokenise free text into prefix-search tokens. */
export function searchTokens(q: string): string[] {
  return q.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export async function ftsIds(
  d: Database,
  tx: any,
  ctx: Ctx,
  table: 'parties' | 'items' | 'documents',
  q: string,
  limit: number,
): Promise<string[]> {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return [];
  if (d.dialect === 'sqlite') {
    const match = tokens.map((t) => `"${t}"*`).join(' ');
    const rows = await queryRows(
      d,
      tx,
      sql.raw(
        `SELECT id FROM ${table}_fts WHERE ${table}_fts MATCH '${match.replace(/'/g, "''")}' AND business_id = '${ctx.businessId}' ORDER BY rank LIMIT ${Math.trunc(limit)}`,
      ),
    );
    return rows.map((r) => String(r['id']));
  }
  const tsq = tokens.map((t) => `${t}:*`).join(' & ');
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT id FROM ${sql.identifier(table)} WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND search @@ to_tsquery('simple', ${tsq}) LIMIT ${limit}`,
  );
  return rows.map((r) => String(r['id']));
}

export interface ListOptions {
  where?: any;
  limit?: number;
  offset?: number;
  orderBy?: any;
}

/** Generic aggregate repository: tenant scoping, optimistic concurrency, audit, soft delete. */
export class BaseRepo {
  constructor(
    protected readonly d: Database,
    readonly name: TableName,
  ) {}

  protected get t(): any {
    return this.d.schema[this.name];
  }

  /** Subclasses throw `RuleError` to veto a soft delete. */
  protected async beforeSoftDelete(_ctx: Ctx, _tx: any, _row: Row): Promise<void> {}

  async get(ctx: Ctx, id: string): Promise<Row | null> {
    return runInTx(this.d, ctx, (tx) => this.getIn(tx, ctx, id));
  }

  protected async getIn(
    tx: any,
    ctx: Ctx,
    id: string,
    includeDeleted = false,
  ): Promise<Row | null> {
    const t = this.t;
    const conds = [eq(t.id, id), eq(t.business_id, ctx.businessId)];
    if (!includeDeleted) conds.push(isNull(t.deleted_at));
    const rows = await tx
      .select()
      .from(t)
      .where(and(...conds))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(ctx: Ctx, opts: ListOptions = {}): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      let q = tx
        .select()
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at), opts.where));
      q = q.orderBy(opts.orderBy ?? t.created_at);
      if (opts.limit !== undefined) q = q.limit(opts.limit);
      if (opts.offset !== undefined) q = q.offset(opts.offset);
      return q;
    });
  }

  async create(ctx: Ctx, values: NewRow & { id?: string }): Promise<Row> {
    return runInTx(this.d, ctx, (tx) => this.createIn(tx, ctx, values));
  }

  protected async createIn(tx: any, ctx: Ctx, values: NewRow & { id?: string }): Promise<Row> {
    const now = Date.now();
    const row = {
      ...values,
      id: values.id ?? newId(),
      org_id: ctx.orgId,
      business_id: ctx.businessId,
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: ctx.actor,
      updated_by: ctx.actor,
    };
    const [created] = await tx.insert(this.t).values(row).returning();
    await writeAudit(this.d, tx, ctx, this.name, created.id, 'insert', null, created);
    return created;
  }

  /** Optimistic update: fails with `ConflictError` when `expectedVersion` is stale. */
  async update(ctx: Ctx, id: string, patch: NewRow, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, (tx) => this.updateIn(tx, ctx, id, patch, expectedVersion));
  }

  protected async updateIn(
    tx: any,
    ctx: Ctx,
    id: string,
    patch: NewRow,
    expectedVersion: number,
  ): Promise<Row> {
    const t = this.t;
    const before = await this.getIn(tx, ctx, id);
    if (!before) throw new NotFoundError(this.name, id);
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => !PROTECTED.has(k)));
    const [after] = await tx
      .update(t)
      .set({
        ...clean,
        version: sql`${t.version} + 1`,
        updated_at: Date.now(),
        updated_by: ctx.actor,
      })
      .where(
        and(
          eq(t.id, id),
          eq(t.business_id, ctx.businessId),
          eq(t.version, expectedVersion),
          isNull(t.deleted_at),
        ),
      )
      .returning();
    if (!after) throw new ConflictError(this.name, id, expectedVersion);
    await writeAudit(this.d, tx, ctx, this.name, id, 'update', before, after);
    return after;
  }

  async softDelete(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const before = await this.getIn(tx, ctx, id);
      if (!before) throw new NotFoundError(this.name, id);
      await this.beforeSoftDelete(ctx, tx, before);
      const now = Date.now();
      const [after] = await tx
        .update(t)
        .set({
          deleted_at: now,
          version: sql`${t.version} + 1`,
          updated_at: now,
          updated_by: ctx.actor,
        })
        .where(
          and(
            eq(t.id, id),
            eq(t.business_id, ctx.businessId),
            eq(t.version, expectedVersion),
            isNull(t.deleted_at),
          ),
        )
        .returning();
      if (!after) throw new ConflictError(this.name, id, expectedVersion);
      await writeAudit(this.d, tx, ctx, this.name, id, 'soft_delete', before, after);
      return after;
    });
  }

  /** Load rows by id, preserving the order of `ids`. */
  protected async byIds(tx: any, ctx: Ctx, ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    const t = this.t;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at), inArray(t.id, ids)));
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => order.get(a['id'])! - order.get(b['id'])!);
  }

  /** True if any row in `table` references `id` through `column` (deleted rows included). */
  protected async isReferenced(
    tx: any,
    ctx: Ctx,
    table: TableName,
    column: string,
    id: string,
  ): Promise<boolean> {
    const tt = this.d.schema[table];
    const rows = await tx
      .select({ id: tt.id })
      .from(tt)
      .where(and(eq(tt.business_id, ctx.businessId), eq(tt[column], id)))
      .limit(1);
    return rows.length > 0;
  }
}
