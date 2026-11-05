/**
 * Basic inventory (prompt 19, FR-110). Stock is the sum of an item's `stock_movements`: documents write
 * them when they are issued (and reverse them when cancelled, in `document-flow.ts`), and this
 * repository adds manual adjustments, physical counts and the checks around them. Nothing is stored
 * as "current stock", so it cannot drift from the movements it came from.
 */
import {
  DEFAULT_STOCK_POLICY,
  ADJUST_REASONS,
  isAdjustReason,
  isLow,
  isStockPolicy,
  stockDecision,
  stockEffectOf,
  sumByItem,
  type CountRow,
  type DocumentType,
  type Shortfall,
  type StockDecision,
  type StockNeed,
  type StockPolicy,
} from '@gst/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { SettingsRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import { PeriodLockRepo } from './period-lock';

const POLICY_KEY = 'inventory.policy';

/** A document would take stock below zero and the business does not allow that. */
export class InsufficientStockError extends RuleError {
  override name = 'InsufficientStockError';
  constructor(readonly shortfalls: Shortfall[]) {
    super(
      `Not enough stock: ${shortfalls
        .map((s) => `${s.name} (have ${s.onHandMicros / 1e6}, need ${s.needMicros / 1e6})`)
        .join('; ')}`,
    );
  }
}

const n = (v: unknown): number => Number(v ?? 0);

/* ------------------------------------------------------------------ shared reads (inside a transaction) */

/** Stock on hand per item: the sum of its movements. Items with none are absent (zero). */
export async function onHandIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  itemIds?: readonly string[],
): Promise<Map<string, number>> {
  if (itemIds && itemIds.length === 0) return new Map();
  const only = itemIds
    ? sql`AND item_id IN (${sql.join(
        itemIds.map((i) => sql`${i}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT item_id, sum(qty_micros) AS v FROM stock_movements
        WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL ${only}
        GROUP BY item_id`,
  );
  return new Map(rows.map((r) => [String(r['item_id']), n(r['v'])]));
}

export async function stockPolicyIn(tx: any, ctx: Ctx, d: Database): Promise<StockPolicy> {
  const v = await new SettingsRepo(d).getValue<unknown>({ ...ctx, tx }, POLICY_KEY);
  return isStockPolicy(v) ? v : DEFAULT_STOCK_POLICY;
}

/** Tracked items among `ids`, by id. */
async function trackedIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  ids: readonly string[],
): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const items = d.schema.items;
  const rows: Row[] = await tx
    .select()
    .from(items)
    .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
  const wanted = new Set(ids);
  return new Map(
    rows.filter((r) => wanted.has(r['id']) && r['track_stock']).map((r) => [String(r['id']), r]),
  );
}

export interface IssueLine {
  itemId: string | null | undefined;
  qtyMicros: number;
}

/**
 * What issuing a document would do to stock, under the business's policy. Only items that track
 * stock count; a document that moves stock in, or none, always passes.
 */
export async function checkIssueIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  type: DocumentType,
  lines: readonly IssueLine[],
  meta?: { reduceStock?: boolean | null },
): Promise<{ policy: StockPolicy; decision: StockDecision }> {
  const policy = await stockPolicyIn(tx, ctx, d);
  if (stockEffectOf(type, meta) !== 'out') return { policy, decision: { action: 'ok' } };
  const need = sumByItem(lines.map((l) => ({ itemId: l.itemId, qtyMicros: l.qtyMicros })));
  const items = await trackedIn(d, tx, ctx, [...need.keys()]);
  const onHand = await onHandIn(d, tx, ctx, [...items.keys()]);
  const needs: StockNeed[] = [...items.values()].map((i) => ({
    itemId: String(i['id']),
    name: String(i['name']),
    onHandMicros: onHand.get(String(i['id'])) ?? 0,
    needMicros: need.get(String(i['id'])) ?? 0,
  }));
  return { policy, decision: stockDecision(policy, needs) };
}

/* ------------------------------------------------------------------ the repository */

export interface AdjustLine {
  itemId: string;
  /** Positive adds stock, negative removes it. */
  deltaMicros: number;
}

export interface AdjustInput {
  date: string;
  reason: string;
  note?: string;
  lines: AdjustLine[];
}

export interface AdjustResult {
  adjusted: {
    itemId: string;
    name: string;
    beforeMicros: number;
    deltaMicros: number;
    afterMicros: number;
  }[];
}

export interface CountInput {
  date: string;
  note?: string;
  counts: { itemId: string; countedMicros: number }[];
}

export interface MovementRow {
  id: string;
  date: string;
  kind: string;
  qtyMicros: number;
  ratePaise: number;
  note: string;
  documentId: string | null;
  documentNumber: string | null;
  documentType: string | null;
}

export interface CountMatch {
  matched: { row: CountRow; itemId: string; name: string; sku: string; onHandMicros: number }[];
  /** No tracked item has this SKU, barcode or name. */
  missing: CountRow[];
  /** More than one item has it (only possible by name). */
  ambiguous: CountRow[];
  /** The item exists but does not track stock. */
  untracked: CountRow[];
}

export interface LowStockRow {
  itemId: string;
  name: string;
  sku: string;
  onHandMicros: number;
  minMicros: number;
}

export class InventoryRepo extends BaseRepo {
  private readonly lock: PeriodLockRepo;

  constructor(d: Database) {
    super(d, 'stock_movements');
    this.lock = new PeriodLockRepo(d);
  }

  /** Stock on hand per item (the sum of its movements); items with none are absent. */
  async onHand(ctx: Ctx, itemIds?: readonly string[]): Promise<Map<string, number>> {
    return runInTx(this.d, ctx, (tx) => onHandIn(this.d, tx, ctx, itemIds));
  }

  async getPolicy(ctx: Ctx): Promise<StockPolicy> {
    return runInTx(this.d, ctx, (tx) => stockPolicyIn(tx, ctx, this.d));
  }

  async setPolicy(ctx: Ctx, policy: StockPolicy): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      if (!isStockPolicy(policy)) throw new RuleError('The stock policy is allow or block.');
      await new SettingsRepo(this.d).set({ ...ctx, tx }, POLICY_KEY, policy);
    });
  }

  /** The decision for a document that is about to be issued, so the screen can warn first. */
  async checkIssue(
    ctx: Ctx,
    type: DocumentType,
    lines: readonly IssueLine[],
    meta?: { reduceStock?: boolean | null },
  ) {
    return runInTx(this.d, ctx, (tx) => checkIssueIn(this.d, tx, ctx, type, lines, meta));
  }

  /** The movements of one item, newest first, with the document each came from. */
  async movementsOf(ctx: Ctx, itemId: string, limit = 200): Promise<MovementRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT m.id, m.date, m.kind, m.qty_micros, m.rate_paise, m.note, m.document_id,
                   dc.number AS doc_number, dc.type AS doc_type
            FROM stock_movements m LEFT JOIN documents dc ON dc.id = m.document_id
            WHERE m.business_id = ${ctx.businessId} AND m.deleted_at IS NULL AND m.item_id = ${itemId}
            ORDER BY m.date DESC, m.created_at DESC, m.id DESC LIMIT ${limit}`,
      );
      return rows.map((r) => ({
        id: String(r['id']),
        date: String(r['date']),
        kind: String(r['kind']),
        qtyMicros: n(r['qty_micros']),
        ratePaise: n(r['rate_paise']),
        note: r['note'] == null ? '' : String(r['note']),
        documentId: r['document_id'] == null ? null : String(r['document_id']),
        documentNumber: r['doc_number'] == null ? null : String(r['doc_number']),
        documentType: r['doc_type'] == null ? null : String(r['doc_type']),
      }));
    });
  }

  /** Items that track stock and are below their reorder level, most short first. */
  async lowStock(ctx: Ctx): Promise<LowStockRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT i.id, i.name, coalesce(i.sku, '') AS sku, coalesce(i.min_stock_micros, 0) AS min_stock,
                   coalesce(m.v, 0) AS on_hand
            FROM items i
            LEFT JOIN (
              SELECT item_id, sum(qty_micros) AS v FROM stock_movements
              WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL GROUP BY item_id
            ) m ON m.item_id = i.id
            WHERE i.business_id = ${ctx.businessId} AND i.deleted_at IS NULL AND i.track_stock = ${true}
              AND coalesce(i.min_stock_micros, 0) > 0`,
      );
      return rows
        .map((r) => ({
          itemId: String(r['id']),
          name: String(r['name']),
          sku: String(r['sku']),
          onHandMicros: n(r['on_hand']),
          minMicros: n(r['min_stock']),
        }))
        .filter((r) => isLow(r.onHandMicros, r.minMicros))
        .sort((a, b) => a.onHandMicros - a.minMicros - (b.onHandMicros - b.minMicros));
    });
  }

  /**
   * Book stock in or out by hand, with a reason. One movement per item, all in one transaction, so a
   * bad line stops the whole entry. Each movement is audited like every other record.
   */
  async adjust(ctx: Ctx, input: AdjustInput): Promise<AdjustResult> {
    return runInTx(this.d, ctx, (tx) => this.adjustIn(tx, { ...ctx, tx }, input));
  }

  /**
   * Bring stock to what was counted: for each item the difference between the count and what the
   * movements say, worked out inside the transaction so a sale made a moment ago is not overwritten.
   * Items already at the counted quantity are left alone.
   */
  async applyCount(ctx: Ctx, input: CountInput): Promise<AdjustResult> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const ids = input.counts.map((x) => x.itemId);
      const onHand = await onHandIn(this.d, tx, c, ids);
      const lines = input.counts
        .map((x) => ({
          itemId: x.itemId,
          deltaMicros: x.countedMicros - (onHand.get(x.itemId) ?? 0),
        }))
        .filter((l) => l.deltaMicros !== 0);
      if (input.counts.some((x) => !Number.isInteger(x.countedMicros) || x.countedMicros < 0))
        throw new RuleError('A counted quantity cannot be negative.');
      if (lines.length === 0) return { adjusted: [] };
      return this.adjustIn(tx, c, {
        date: input.date,
        reason: 'count',
        ...(input.note ? { note: input.note } : {}),
        lines,
      });
    });
  }

  /** Match the rows of a count sheet to items by SKU, barcode or name. */
  async matchCount(ctx: Ctx, rows: readonly CountRow[]): Promise<CountMatch> {
    return runInTx(this.d, ctx, async (tx) => {
      const items = this.d.schema.items;
      const all: Row[] = await tx
        .select()
        .from(items)
        .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
      const onHand = await onHandIn(this.d, tx, ctx);
      const lower = (v: unknown) =>
        String(v ?? '')
          .trim()
          .toLowerCase();
      const out: CountMatch = { matched: [], missing: [], ambiguous: [], untracked: [] };
      for (const row of rows) {
        const key = lower(row.key);
        const field = row.by === 'sku' ? 'sku' : row.by === 'barcode' ? 'barcode' : 'name';
        const hits = all.filter((i) => lower(i[field]) === key);
        if (hits.length === 0) out.missing.push(row);
        else if (hits.length > 1) out.ambiguous.push(row);
        else if (!hits[0]!['track_stock']) out.untracked.push(row);
        else {
          const i = hits[0]!;
          out.matched.push({
            row,
            itemId: String(i['id']),
            name: String(i['name']),
            sku: String(i['sku'] ?? ''),
            onHandMicros: onHand.get(String(i['id'])) ?? 0,
          });
        }
      }
      return out;
    });
  }

  private async adjustIn(tx: any, c: Ctx, input: AdjustInput): Promise<AdjustResult> {
    if (!isAdjustReason(input.reason))
      throw new RuleError(`The reason is one of: ${ADJUST_REASONS.join(', ')}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
      throw new RuleError('Give the date of the adjustment.');
    if (input.lines.length === 0) throw new RuleError('Add at least one item to adjust.');
    const ids = input.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw new RuleError('An item is listed twice.');
    for (const l of input.lines) {
      if (!Number.isInteger(l.deltaMicros) || l.deltaMicros === 0)
        throw new RuleError('Each line needs a quantity to add or remove.');
    }
    await this.lock.assertOpen(c, input.date, { action: 'adjust stock', documentId: ids[0]! });

    const items = await trackedIn(this.d, tx, c, ids);
    const onHand = await onHandIn(this.d, tx, c, ids);
    const g = this.d.schema.godowns;
    const [godown]: Row[] = await tx
      .select({ id: g.id })
      .from(g)
      .where(and(eq(g.business_id, c.businessId), eq(g.is_default, true), isNull(g.deleted_at)))
      .limit(1);
    const adjusted: AdjustResult['adjusted'] = [];
    for (const l of input.lines) {
      const item = items.get(l.itemId);
      if (!item) {
        // either missing, or it does not track stock: say which
        const [exists]: Row[] = await tx
          .select({ id: this.d.schema.items.id })
          .from(this.d.schema.items)
          .where(
            and(
              eq(this.d.schema.items.id, l.itemId),
              eq(this.d.schema.items.business_id, c.businessId),
            ),
          )
          .limit(1);
        if (!exists) throw new NotFoundError('items', l.itemId);
        throw new RuleError('This item does not track stock. Turn on stock tracking for it first.');
      }
      const before = onHand.get(l.itemId) ?? 0;
      await this.createIn(tx, c, {
        item_id: l.itemId,
        godown_id: godown?.['id'] ?? null,
        kind: 'adjust',
        qty_micros: l.deltaMicros,
        rate_paise: n(item['purchase_rate_paise']),
        date: input.date,
        note: input.note?.trim() ? `${input.reason}: ${input.note.trim()}` : input.reason,
      });
      adjusted.push({
        itemId: l.itemId,
        name: String(item['name']),
        beforeMicros: before,
        deltaMicros: l.deltaMicros,
        afterMicros: before + l.deltaMicros,
      });
    }
    return { adjusted };
  }
}
