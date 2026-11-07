/**
 * Basic inventory (prompt 19, FR-110). Stock is the sum of an item's `stock_movements`: documents write
 * them when they are issued (and reverse them when cancelled, in `document-flow.ts`), and this
 * repository adds manual adjustments, physical counts and the checks around them. Nothing is stored
 * as "current stock", so it cannot drift from the movements it came from.
 */
import {
  DEFAULT_STOCK_POLICY,
  ADJUST_REASONS,
  checkSerials,
  isAdjustReason,
  isLow,
  isStockPolicy,
  parseSerials,
  serialCountMatches,
  stockDecision,
  stockEffectOf,
  sumByItem,
  valueAt,
  type CountRow,
  type DocumentType,
  type Shortfall,
  type StockDecision,
  type StockNeed,
  type StockPolicy,
  type TrackingMode,
} from '@gst/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { SettingsRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import {
  batchOnHandIn,
  jsonList,
  placeSerialsIn,
  serialStatesIn,
  toBatch,
  type BatchView,
} from './batches';
import { defaultGodownIdIn, godownKey, onHandByGodownIn, toGodown, type Godown } from './godowns';
import { PeriodLockRepo } from './period-lock';
import { postStockVoucherIn, stockLines, valuationIn, valueItemIn } from './stock-ledger';

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
        WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND kind <> 'transfer' ${only}
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
  /** Which godown; the item's default, then the business's, when not given. */
  godownId?: string | null;
  /** Batch-tracked items: the batch adjusted. */
  batchId?: string | null;
  /** Serial-tracked items: the serials added or removed (one per unit). */
  serials?: readonly string[];
  /** Stock in at this cost per unit; otherwise the item's current cost (or purchase price). */
  unitCostPaise?: number | null;
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
  /** Count one godown; otherwise the counts are the whole business's. */
  godownId?: string | null;
  counts: { itemId: string; countedMicros: number; batchId?: string | null }[];
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
  godownId: string | null;
  godownName: string;
  batchId: string | null;
  batchNo: string;
  serials: string[];
  costPaise: number | null;
  transferId: string | null;
}

export interface ItemStockDetail {
  onHandMicros: number;
  trackingMode: TrackingMode;
  byGodown: { godown: Godown; onHandMicros: number }[];
  batches: BatchView[];
  serialsInStock: number;
  /** Under the business's method; at purchase price when none is set. */
  valuePaise: bigint;
  unitCostPaise: bigint;
  method: 'fifo' | 'wavg' | null;
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
                   m.godown_id, m.batch_id, m.serials_json, m.cost_paise, m.transfer_id,
                   dc.number AS doc_number, dc.type AS doc_type, g.name AS godown_name, b.batch_no
            FROM stock_movements m
            LEFT JOIN documents dc ON dc.id = m.document_id
            LEFT JOIN godowns g ON g.id = m.godown_id
            LEFT JOIN batches b ON b.id = m.batch_id
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
        godownId: r['godown_id'] == null ? null : String(r['godown_id']),
        godownName: r['godown_name'] == null ? '' : String(r['godown_name']),
        batchId: r['batch_id'] == null ? null : String(r['batch_id']),
        batchNo: r['batch_no'] == null ? '' : String(r['batch_no']),
        serials: jsonList(r['serials_json']),
        costPaise: r['cost_paise'] == null ? null : n(r['cost_paise']),
        transferId: r['transfer_id'] == null ? null : String(r['transfer_id']),
      }));
    });
  }

  /** One item's stock in full: per godown, per batch, serials in stock, and its value. */
  async itemDetail(ctx: Ctx, itemId: string): Promise<ItemStockDetail> {
    return runInTx(this.d, ctx, async (tx) => {
      const items = this.d.schema.items;
      const [item]: Row[] = await tx
        .select()
        .from(items)
        .where(
          and(
            eq(items.id, itemId),
            eq(items.business_id, ctx.businessId),
            isNull(items.deleted_at),
          ),
        )
        .limit(1);
      if (!item) throw new NotFoundError('items', itemId);
      const mode = (String(item['tracking_mode'] ?? 'none') || 'none') as TrackingMode;
      const onHand = (await onHandIn(this.d, tx, ctx, [itemId])).get(itemId) ?? 0;
      const g = this.d.schema.godowns;
      const godownRows: Row[] = await tx
        .select()
        .from(g)
        .where(and(eq(g.business_id, ctx.businessId), isNull(g.deleted_at)));
      const byGodown = await onHandByGodownIn(this.d, tx, ctx, { itemIds: [itemId] });
      const b = this.d.schema.batches;
      const batchRows: Row[] = await tx
        .select()
        .from(b)
        .where(and(eq(b.business_id, ctx.businessId), eq(b.item_id, itemId), isNull(b.deleted_at)));
      const byBatch = await batchOnHandIn(this.d, tx, ctx, { itemIds: [itemId] });
      const serialRows = await queryRows(
        this.d,
        tx,
        sql`SELECT count(*) AS c FROM serials WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL
            AND item_id = ${itemId} AND status = 'in_stock'`,
      );
      const valuation = await valuationIn(this.d, tx, ctx);
      const rate = BigInt(Math.round(n(item['purchase_rate_paise'])));
      const valued = valuation
        ? await valueItemIn(this.d, tx, ctx, itemId, valuation.method)
        : null;
      return {
        onHandMicros: onHand,
        trackingMode: mode,
        byGodown: godownRows
          .map(toGodown)
          .map((godown) => ({
            godown,
            onHandMicros: byGodown.get(godownKey(itemId, godown.id)) ?? 0,
          }))
          .filter((x) => x.onHandMicros !== 0 || x.godown.isDefault)
          .sort((x, y) => x.godown.name.localeCompare(y.godown.name)),
        batches: batchRows
          .map((r) => ({
            ...toBatch(r),
            onHandMicros: byBatch.get(`${itemId}|${String(r['id'])}`) ?? 0,
          }))
          .sort(
            (x, y) =>
              (x.expiryDate ?? '9999').localeCompare(y.expiryDate ?? '9999') ||
              x.batchNo.localeCompare(y.batchNo),
          ),
        serialsInStock: n(serialRows[0]?.['c']),
        valuePaise: valued ? valued.valuePaise : valueAt(onHand, rate),
        unitCostPaise: valued ? valued.unitCostPaise : rate,
        method: valuation?.method ?? null,
      };
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
              WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND kind <> 'transfer'
              GROUP BY item_id
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
      const godownId = input.godownId ?? null;
      const onHand = godownId
        ? await onHandByGodownIn(this.d, tx, c, { itemIds: ids, godownId })
        : await onHandIn(this.d, tx, c, ids);
      const byBatch = input.counts.some((x) => x.batchId)
        ? await batchOnHandIn(this.d, tx, c, { itemIds: ids, godownId })
        : new Map<string, number>();
      const have = (x: CountInput['counts'][number]): number =>
        x.batchId
          ? (byBatch.get(`${x.itemId}|${x.batchId}`) ?? 0)
          : godownId
            ? (onHand.get(godownKey(x.itemId, godownId)) ?? 0)
            : (onHand.get(x.itemId) ?? 0);
      const lines: AdjustLine[] = input.counts
        .map((x) => ({
          itemId: x.itemId,
          deltaMicros: x.countedMicros - have(x),
          godownId,
          batchId: x.batchId ?? null,
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

  /** Match the rows of a count sheet to items by SKU, barcode or name (what they hold in one godown, when given). */
  async matchCount(
    ctx: Ctx,
    rows: readonly CountRow[],
    opts: { godownId?: string | null } = {},
  ): Promise<CountMatch> {
    return runInTx(this.d, ctx, async (tx) => {
      const items = this.d.schema.items;
      const all: Row[] = await tx
        .select()
        .from(items)
        .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
      const perGodown = opts.godownId
        ? await onHandByGodownIn(this.d, tx, ctx, { godownId: opts.godownId })
        : null;
      const onHand = perGodown
        ? new Map([...perGodown.entries()].map(([k, v]) => [k.split('|')[0]!, v]))
        : await onHandIn(this.d, tx, ctx);
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
    // the same item may appear once per batch, godown or serial list, never twice the same way
    const keys = input.lines.map((l) => `${l.itemId}|${l.godownId ?? ''}|${l.batchId ?? ''}`);
    if (new Set(keys).size !== keys.length) throw new RuleError('An item is listed twice.');
    for (const l of input.lines) {
      if (!Number.isInteger(l.deltaMicros) || l.deltaMicros === 0)
        throw new RuleError('Each line needs a quantity to add or remove.');
      if (l.unitCostPaise != null && (!Number.isInteger(l.unitCostPaise) || l.unitCostPaise < 0))
        throw new RuleError('A cost per unit is a whole number of paise, zero or more.');
    }
    await this.lock.assertOpen(c, input.date, { action: 'adjust stock', documentId: ids[0]! });

    const items = await trackedIn(this.d, tx, c, ids);
    const onHand = await onHandIn(this.d, tx, c, ids);
    const defaultGodown = await defaultGodownIdIn(this.d, tx, c);
    const valuation = await valuationIn(this.d, tx, c);
    const adjusted: AdjustResult['adjusted'] = [];
    const written: { id: string; itemId: string; version: number; deltaMicros: number }[] = [];
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
      const mode = (String(item['tracking_mode'] ?? 'none') || 'none') as TrackingMode;
      const godownId = l.godownId ?? (item['default_godown_id'] as string | null) ?? defaultGodown;
      const direction = l.deltaMicros > 0 ? 'in' : 'out';
      let batchId: string | null = null;
      let serials: string[] = [];
      if (mode === 'batch') {
        if (!l.batchId) throw new RuleError(`${item['name']}: choose the batch to adjust.`);
        const b = await new BaseRepo(this.d, 'batches').get(c, l.batchId);
        if (!b || b['item_id'] !== l.itemId)
          throw new RuleError(`${item['name']}: that batch is not one of its batches.`);
        batchId = l.batchId;
      }
      if (mode === 'serial') {
        serials = parseSerials((l.serials ?? []).join('\n')).serials;
        if (!serialCountMatches(serials, Math.abs(l.deltaMicros)))
          throw new RuleError(`${item['name']}: list one serial number per unit.`);
        const states = await serialStatesIn(
          this.d,
          tx,
          c,
          l.itemId,
          serials,
          direction === 'out' ? godownId : null,
        );
        const check = checkSerials(serials, states, direction);
        if (check.unavailable.length > 0)
          throw new RuleError(
            `${item['name']}: not in stock: ${check.unavailable.slice(0, 5).join(', ')}`,
          );
        if (check.alreadyIn.length > 0)
          throw new RuleError(
            `${item['name']}: already in stock: ${check.alreadyIn.slice(0, 5).join(', ')}`,
          );
        batchId = l.batchId ?? null;
      }
      const before = onHand.get(l.itemId) ?? 0;
      // stock in carries the cost it is booked at; stock out is costed by the method (or not at all)
      let cost: number | null = null;
      if (direction === 'in') {
        let unit = l.unitCostPaise ?? null;
        if (unit == null && valuation) {
          const cur = await valueItemIn(this.d, tx, c, l.itemId, valuation.method);
          unit = cur.qtyMicros > 0 ? Number(cur.unitCostPaise) : n(item['purchase_rate_paise']);
        }
        if (unit == null) unit = n(item['purchase_rate_paise']);
        cost = Number(valueAt(l.deltaMicros, BigInt(unit)));
      }
      const row = await this.createIn(tx, c, {
        item_id: l.itemId,
        godown_id: godownId,
        batch_id: batchId,
        kind: 'adjust',
        qty_micros: l.deltaMicros,
        rate_paise:
          direction === 'in' && l.deltaMicros > 0 && cost != null
            ? Math.round((cost * 1_000_000) / l.deltaMicros)
            : n(item['purchase_rate_paise']),
        cost_paise: cost,
        serials_json: serials.length > 0 ? serials : null,
        date: input.date,
        note: input.note?.trim() ? `${input.reason}: ${input.note.trim()}` : input.reason,
      });
      if (serials.length > 0)
        await placeSerialsIn(this.d, tx, c, {
          itemId: l.itemId,
          serials,
          godownId,
          batchId,
          status: direction === 'in' ? 'in_stock' : 'out',
          movementId: String(row['id']),
        });
      written.push({
        id: String(row['id']),
        itemId: l.itemId,
        version: n(row['version']),
        deltaMicros: l.deltaMicros,
      });
      onHand.set(l.itemId, before + l.deltaMicros);
      adjusted.push({
        itemId: l.itemId,
        name: String(item['name']),
        beforeMicros: before,
        deltaMicros: l.deltaMicros,
        afterMicros: before + l.deltaMicros,
      });
    }

    if (valuation) {
      // cost every movement under the method and carry the lot into the books with one voucher
      let inPaise = 0n;
      let outPaise = 0n;
      const costs = new Map<string, bigint>();
      for (const itemId of new Set(written.map((w) => w.itemId))) {
        const r = await valueItemIn(this.d, tx, c, itemId, valuation.method);
        for (const w of written.filter((x) => x.itemId === itemId)) {
          const cost = r.costs.get(w.id) ?? 0n;
          costs.set(w.id, cost);
          if (w.deltaMicros > 0) inPaise += cost;
          else outPaise += cost;
        }
      }
      const against = input.reason === 'opening' ? 'openingEquity' : 'adjustments';
      const narration = `Stock adjustment (${input.reason})${input.note?.trim() ? `: ${input.note.trim()}` : ''}`;
      const voucherId = await postStockVoucherIn(this.d, tx, c, {
        date: input.date,
        narration,
        lines: [
          ...stockLines('in', inPaise, against, narration),
          ...stockLines('out', outPaise, against, narration),
        ],
      });
      for (const w of written)
        await this.updateIn(
          tx,
          c,
          w.id,
          { cost_paise: Number(costs.get(w.id) ?? 0n), voucher_id: voucherId },
          w.version,
        );
    }
    return { adjusted };
  }
}
