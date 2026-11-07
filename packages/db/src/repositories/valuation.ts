/**
 * The business's valuation method and what its stock is worth (prompt 51, FR-112). Choosing a method
 * starts the postings (`stock-ledger.ts`) and brings the Inventory ledger to the value of what is on
 * hand with one true-up voucher; changing it later is a migration: every item is re-costed under the
 * new method, the movements' costs are rewritten, and the difference is posted the same way. `verify`
 * says whether the ledger still equals the stock value, and `trueUp` makes it so.
 */
import {
  ageStock,
  isValuationMethod,
  valueAt,
  type ValuationMethod,
  type ValuationResult,
} from '@gst/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { SettingsRepo } from './aggregates';
import { BaseRepo, RuleError, runInTx, type Ctx } from './base';
import { batchKey, batchOnHandIn, toBatch } from './batches';
import { defaultGodownIdIn, godownKey, onHandByGodownIn } from './godowns';
import {
  VALUATION_KEY,
  inventoryLedgerBalanceIn,
  postStockVoucherIn,
  stockLines,
  valuationIn,
  valueItemIn,
  type ValuationSetting,
} from './stock-ledger';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));

export interface StockValueRow {
  itemId: string;
  name: string;
  sku: string;
  batchId: string | null;
  batchNo: string | null;
  expiryDate: string | null;
  godownId: string | null;
  qtyMicros: number;
  unitCostPaise: bigint;
  valuePaise: bigint;
}

export interface ValuationCheck {
  method: ValuationMethod | null;
  /** Every item's stock at the method's cost (purchase price when no method is set). */
  stockValuePaise: bigint;
  /** The Inventory ledger's balance. */
  ledgerPaise: bigint;
  differencePaise: bigint;
  items: number;
}

export interface ItemValuation extends ValuationResult {
  itemId: string;
  name: string;
  sku: string;
  purchaseRatePaise: bigint;
}

export class ValuationRepo {
  constructor(private readonly d: Database) {}

  async get(ctx: Ctx): Promise<ValuationSetting | null> {
    return runInTx(this.d, ctx, (tx) => valuationIn(this.d, tx, ctx));
  }

  /** Whether any stock has moved: once it has, the method is set for good unless migrated. */
  async locked(ctx: Ctx): Promise<boolean> {
    return runInTx(this.d, ctx, async (tx) => {
      const cur = await valuationIn(this.d, tx, ctx);
      if (!cur) return false;
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT count(*) AS c FROM stock_movements
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND kind <> 'transfer'`,
      );
      return n(rows[0]?.['c']) > 0;
    });
  }

  /**
   * Choose the method. The first choice starts the postings and trues the ledger up to the stock
   * value. A later change needs `migrate`: every item is re-costed, the movements' costs rewritten,
   * and the difference posted, dated `today`.
   */
  async set(
    ctx: Ctx,
    method: ValuationMethod,
    opts: { today: string; migrate?: boolean },
  ): Promise<{ voucherId: string | null; recosted: number }> {
    if (!isValuationMethod(method)) throw new RuleError('The method is FIFO or weighted average.');
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const cur = await valuationIn(this.d, tx, ctx);
      if (cur?.method === method) return { voucherId: null, recosted: 0 };
      if (cur && !opts.migrate && (await this.locked(c)))
        throw new RuleError(
          'Stock has already been valued under the current method. Migrate to change it.',
        );
      await new SettingsRepo(this.d).set(c, VALUATION_KEY, { method, since: opts.today });
      const recosted = await this.recostIn(tx, ctx, method);
      const voucherId = await this.trueUpIn(
        tx,
        ctx,
        opts.today,
        cur
          ? `Valuation method changed from ${label(cur.method)} to ${label(method)}`
          : `Stock valued at ${label(method)} from ${opts.today}`,
      );
      return { voucherId, recosted };
    });
  }

  /** Rewrite every costed movement's `cost_paise` to what the method says now. */
  private async recostIn(tx: any, ctx: Ctx, method: ValuationMethod): Promise<number> {
    const movements = new BaseRepo(this.d, 'stock_movements');
    const m = this.d.schema.stock_movements;
    let changed = 0;
    for (const item of await this.itemsIn(tx, ctx)) {
      const r = await valueItemIn(this.d, tx, ctx, String(item['id']), method);
      const rows: Row[] = await tx
        .select({
          id: m.id,
          version: m.version,
          cost: m.cost_paise,
          fixed: m.cost_fixed,
          qty: m.qty_micros,
        })
        .from(m)
        .where(
          and(
            eq(m.business_id, ctx.businessId),
            eq(m.item_id, String(item['id'])),
            isNull(m.deleted_at),
            sql`${m.kind} <> 'transfer'`,
          ),
        );
      for (const row of rows) {
        if (row['fixed'] === true || Number(row['fixed']) === 1) continue;
        const cost = r.costs.get(String(row['id']));
        if (cost === undefined) continue;
        if (row['cost'] != null && BigInt(Math.round(Number(row['cost']))) === cost) continue;
        await (movements as any).updateIn(
          tx,
          ctx,
          row['id'],
          { cost_paise: Number(cost) },
          row['version'],
        );
        changed++;
      }
    }
    return changed;
  }

  private async itemsIn(tx: any, ctx: Ctx): Promise<Row[]> {
    const items = this.d.schema.items;
    return tx
      .select({
        id: items.id,
        name: items.name,
        sku: items.sku,
        purchase_rate_paise: items.purchase_rate_paise,
      })
      .from(items)
      .where(
        and(
          eq(items.business_id, ctx.businessId),
          eq(items.track_stock, true),
          isNull(items.deleted_at),
        ),
      )
      .orderBy(items.name);
  }

  /** Every tracked item valued under the method (purchase price when none is set), as at a date. */
  async items(ctx: Ctx, asOf?: string): Promise<ItemValuation[]> {
    return runInTx(this.d, ctx, (tx) => this.itemsValuedIn(tx, ctx, asOf));
  }

  private async itemsValuedIn(tx: any, ctx: Ctx, asOf?: string): Promise<ItemValuation[]> {
    const cur = await valuationIn(this.d, tx, ctx);
    const out: ItemValuation[] = [];
    for (const item of await this.itemsIn(tx, ctx)) {
      const rate = BigInt(Math.round(n(item['purchase_rate_paise'])));
      const id = String(item['id']);
      const base = {
        itemId: id,
        name: s(item['name']),
        sku: s(item['sku']),
        purchaseRatePaise: rate,
      };
      if (cur) {
        out.push({ ...base, ...(await valueItemIn(this.d, tx, ctx, id, cur.method, asOf)) });
      } else {
        // no method: the stock summary's rule, quantity at the current purchase price
        const r = await valueItemIn(this.d, tx, ctx, id, 'wavg', asOf);
        out.push({
          ...base,
          costs: r.costs,
          qtyMicros: r.qtyMicros,
          valuePaise: valueAt(r.qtyMicros, rate),
          unitCostPaise: rate,
          layers: r.layers,
        });
      }
    }
    return out;
  }

  /** Stock value by item, or split by batch or godown at the item's unit cost, as at a date. */
  async report(
    ctx: Ctx,
    opts: { asOf?: string; by: 'item' | 'batch' | 'godown' },
  ): Promise<StockValueRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const items = await this.itemsValuedIn(tx, ctx, opts.asOf);
      const ids = items.map((i) => i.itemId);
      const rows: StockValueRow[] = [];
      const row = (
        i: ItemValuation,
        qty: number,
        extra: Partial<StockValueRow> = {},
      ): StockValueRow => ({
        itemId: i.itemId,
        name: i.name,
        sku: i.sku,
        batchId: null,
        batchNo: null,
        expiryDate: null,
        godownId: null,
        qtyMicros: qty,
        unitCostPaise: i.unitCostPaise,
        valuePaise: valueAt(qty, i.unitCostPaise),
        ...extra,
      });
      if (opts.by === 'item') {
        for (const i of items) rows.push({ ...row(i, i.qtyMicros), valuePaise: i.valuePaise });
        return rows;
      }
      if (opts.by === 'godown') {
        const byGodown = await onHandByGodownIn(this.d, tx, ctx, {
          itemIds: ids,
          ...(opts.asOf ? { upTo: opts.asOf } : {}),
        });
        for (const i of items) {
          const parts = [...byGodown.entries()].filter(([k]) => k.startsWith(`${i.itemId}|`));
          this.pushSplit(
            rows,
            i,
            parts.map(([k, q]) => [k.split('|')[1] ?? '', q]),
            'godownId',
          );
        }
        return rows;
      }
      const byBatch = await batchOnHandIn(this.d, tx, ctx, {
        itemIds: ids,
        ...(opts.asOf ? { upTo: opts.asOf } : {}),
      });
      const b = this.d.schema.batches;
      const batchRows: Row[] = await tx
        .select()
        .from(b)
        .where(and(eq(b.business_id, ctx.businessId), isNull(b.deleted_at)));
      const batches = new Map(batchRows.map((r) => [String(r['id']), toBatch(r)]));
      for (const i of items) {
        const parts = [...byBatch.entries()].filter(([k]) => k.startsWith(`${i.itemId}|`));
        this.pushSplit(
          rows,
          i,
          parts.map(([k, q]) => [k.split('|')[1] ?? '', q]),
          'batchId',
          (id) => {
            const bt = batches.get(id);
            return bt ? { batchNo: bt.batchNo, expiryDate: bt.expiryDate } : {};
          },
        );
      }
      return rows;
    });
  }

  /** Split an item's value over its parts at the unit cost; the last part takes the rounding. */
  private pushSplit(
    rows: StockValueRow[],
    i: ItemValuation,
    parts: [string, number][],
    key: 'godownId' | 'batchId',
    extra: (id: string) => Partial<StockValueRow> = () => ({}),
  ): void {
    // in a fixed order, so two databases holding the same stock give the same report
    const live = parts.filter(([, q]) => q !== 0).sort((a, b) => a[0].localeCompare(b[0]));
    if (live.length === 0) return;
    let spread = 0n;
    live.forEach(([id, qty], idx) => {
      const value = idx === live.length - 1 ? i.valuePaise - spread : valueAt(qty, i.unitCostPaise);
      spread += value;
      rows.push({
        itemId: i.itemId,
        name: i.name,
        sku: i.sku,
        batchId: null,
        batchNo: null,
        expiryDate: null,
        godownId: null,
        [key]: id === '' ? null : id,
        ...extra(id),
        qtyMicros: qty,
        unitCostPaise: i.unitCostPaise,
        valuePaise: value,
      });
    });
  }

  /** Quantity and value on hand by age of the layer it came in on, per item. */
  async ageing(
    ctx: Ctx,
    asOf: string,
  ): Promise<{ item: ItemValuation; qtyMicros: number[]; valuePaise: bigint[] }[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const items = await this.itemsValuedIn(tx, ctx, asOf);
      return items
        .filter((i) => i.qtyMicros > 0)
        .map((i) => ({ item: i, ...ageStock(i.layers, asOf) }));
    });
  }

  /** The stock value against the Inventory ledger, as of now. */
  async verify(ctx: Ctx): Promise<ValuationCheck> {
    return runInTx(this.d, ctx, async (tx) => {
      const cur = await valuationIn(this.d, tx, ctx);
      const items = await this.itemsValuedIn(tx, ctx);
      const stock = items.reduce((t, i) => t + i.valuePaise, 0n);
      const ledger = await inventoryLedgerBalanceIn(this.d, tx, ctx);
      return {
        method: cur?.method ?? null,
        stockValuePaise: stock,
        ledgerPaise: ledger,
        differencePaise: stock - ledger,
        items: items.length,
      };
    });
  }

  /** Post the difference between the stock value and the Inventory ledger, so they tie. */
  async trueUp(
    ctx: Ctx,
    today: string,
    narration = 'Stock valuation true-up',
  ): Promise<string | null> {
    return runInTx(this.d, ctx, (tx) => this.trueUpIn(tx, ctx, today, narration));
  }

  private async trueUpIn(
    tx: any,
    ctx: Ctx,
    today: string,
    narration: string,
  ): Promise<string | null> {
    const cur = await valuationIn(this.d, tx, ctx);
    if (!cur) throw new RuleError('Choose a valuation method first.');
    const items = await this.itemsValuedIn(tx, ctx);
    const stock = items.reduce((t, i) => t + i.valuePaise, 0n);
    const ledger = await inventoryLedgerBalanceIn(this.d, tx, ctx);
    const diff = stock - ledger;
    if (diff === 0n) return null;
    return postStockVoucherIn(this.d, tx, ctx, {
      date: today,
      narration,
      kind: 'reclass',
      lines: stockLines(
        diff > 0n ? 'in' : 'out',
        diff > 0n ? diff : -diff,
        'stockChange',
        narration,
      ),
    });
  }

  /** The default godown, for screens that need to name one. */
  async defaultGodownId(ctx: Ctx): Promise<string | null> {
    return runInTx(this.d, ctx, (tx) => defaultGodownIdIn(this.d, tx, ctx));
  }
}

const label = (m: ValuationMethod): string => (m === 'fifo' ? 'FIFO' : 'weighted average');

export { batchKey, godownKey };
