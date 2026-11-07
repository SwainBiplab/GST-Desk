/**
 * Godowns and transfers between them (prompt 51, FR-111). A godown is a place stock is kept; every
 * movement names one (older rows without one belong to the default). A transfer takes stock out of
 * one godown and brings it into another with `transfer` movements that never change what the business
 * holds in total: dispatched goods are in transit until received, and the two steps are one record.
 */
import {
  checkSerials,
  fyOf,
  parseSerials,
  serialCountMatches,
  type TrackingMode,
} from '@gst/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BusinessRepo, SettingsRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, newId, runInTx, type Ctx } from './base';
import { PeriodLockRepo, type LockOverride } from './period-lock';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));

export interface Godown {
  id: string;
  name: string;
  code: string;
  address: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
}

export const toGodown = (r: Row): Godown => ({
  id: s(r['id']),
  name: s(r['name']),
  code: s(r['code']),
  address: s(r['address']),
  isDefault: !!r['is_default'],
  isActive: r['is_active'] !== false && Number(r['is_active']) !== 0,
  version: n(r['version']),
});

/** The business's default godown id (the first one made with it), or null for a business without one. */
export async function defaultGodownIdIn(d: Database, tx: any, ctx: Ctx): Promise<string | null> {
  const g = d.schema.godowns;
  const [row]: Row[] = await tx
    .select({ id: g.id })
    .from(g)
    .where(and(eq(g.business_id, ctx.businessId), eq(g.is_default, true), isNull(g.deleted_at)))
    .limit(1);
  return row ? String(row['id']) : null;
}

/** Stock per item and godown (the sum of every movement there, transfers included). */
export async function onHandByGodownIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  opts: { itemIds?: readonly string[]; godownId?: string | null; upTo?: string } = {},
): Promise<Map<string, number>> {
  if (opts.itemIds && opts.itemIds.length === 0) return new Map();
  const only = opts.itemIds
    ? sql`AND item_id IN (${sql.join(
        opts.itemIds.map((i) => sql`${i}`),
        sql`, `,
      )})`
    : sql``;
  const fallback = await defaultGodownIdIn(d, tx, ctx);
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT item_id, godown_id, sum(qty_micros) AS v FROM stock_movements
        WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL ${only}
          ${opts.upTo ? sql`AND date <= ${opts.upTo}` : sql``}
        GROUP BY item_id, godown_id`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const godown = r['godown_id'] == null ? fallback : String(r['godown_id']);
    if (opts.godownId && godown !== opts.godownId) continue;
    const key = godownKey(String(r['item_id']), godown);
    out.set(key, (out.get(key) ?? 0) + n(r['v']));
  }
  return out;
}

export const godownKey = (itemId: string, godownId: string | null): string =>
  `${itemId}|${godownId ?? ''}`;

export interface GodownLevel {
  itemId: string;
  godownId: string;
  minMicros: number;
}

export interface GodownStockRow {
  itemId: string;
  name: string;
  sku: string;
  godownId: string;
  onHandMicros: number;
  minMicros: number;
}

export class GodownRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'godowns');
  }

  async all(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<Godown[]> {
    return runInTx(this.d, ctx, (tx) => this.allIn(tx, ctx, opts));
  }

  async allIn(tx: any, ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<Godown[]> {
    const rows: Row[] = await tx
      .select()
      .from(this.t)
      .where(and(eq(this.t.business_id, ctx.businessId), isNull(this.t.deleted_at)))
      .orderBy(asc(this.t.name));
    return rows.map(toGodown).filter((g) => opts.includeInactive || g.isActive);
  }

  async defaultId(ctx: Ctx): Promise<string | null> {
    return runInTx(this.d, ctx, (tx) => defaultGodownIdIn(this.d, tx, ctx));
  }

  async add(ctx: Ctx, input: { name: string; code?: string; address?: string }): Promise<Godown> {
    return runInTx(this.d, ctx, async (tx) => {
      const name = input.name.trim();
      if (name.length < 2) throw new RuleError('Give the godown a name.');
      const all = await this.allIn(tx, ctx, { includeInactive: true });
      if (all.some((g) => g.name.toLowerCase() === name.toLowerCase()))
        throw new RuleError('A godown with this name already exists.');
      const row = await this.createIn(tx, ctx, {
        name,
        code: input.code?.trim() || null,
        address: input.address?.trim() || null,
        is_default: all.length === 0,
        is_active: true,
      });
      return toGodown(row);
    });
  }

  async rename(
    ctx: Ctx,
    id: string,
    patch: { name?: string; code?: string; address?: string },
    version: number,
  ): Promise<Godown> {
    return runInTx(this.d, ctx, async (tx) => {
      const values: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name.length < 2) throw new RuleError('Give the godown a name.');
        values['name'] = name;
      }
      if (patch.code !== undefined) values['code'] = patch.code.trim() || null;
      if (patch.address !== undefined) values['address'] = patch.address.trim() || null;
      return toGodown(await this.updateIn(tx, ctx, id, values, version));
    });
  }

  /** Make one godown the default; the previous default stays a godown. */
  async setDefault(ctx: Ctx, id: string): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const all = await this.allIn(tx, ctx, { includeInactive: true });
      const target = all.find((g) => g.id === id);
      if (!target) throw new NotFoundError('godowns', id);
      if (!target.isActive) throw new RuleError('An archived godown cannot be the default.');
      for (const g of all) {
        if (g.isDefault && g.id !== id)
          await this.updateIn(tx, ctx, g.id, { is_default: false }, g.version);
      }
      if (!target.isDefault) await this.updateIn(tx, ctx, id, { is_default: true }, target.version);
    });
  }

  /** Take a godown out of use. It keeps its history; it cannot be the default or hold stock. */
  async archive(ctx: Ctx, id: string, version: number): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const all = await this.allIn(tx, ctx, { includeInactive: true });
      const g = all.find((x) => x.id === id);
      if (!g) throw new NotFoundError('godowns', id);
      if (g.isDefault) throw new RuleError('Make another godown the default first.');
      const stock = await onHandByGodownIn(this.d, tx, ctx, { godownId: id });
      if ([...stock.values()].some((q) => q !== 0))
        throw new RuleError('Move the stock out of this godown first.');
      await this.updateIn(tx, ctx, id, { is_active: false }, version);
    });
  }

  async unarchive(ctx: Ctx, id: string, version: number): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      await this.updateIn(tx, ctx, id, { is_active: true }, version);
    });
  }

  /** Stock on hand per item and godown, with the godown's own reorder level when one is set. */
  async stock(ctx: Ctx, opts: { itemIds?: readonly string[] } = {}): Promise<GodownStockRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const onHand = await onHandByGodownIn(this.d, tx, ctx, opts);
      const levels = await this.levelsIn(tx, ctx);
      const items = this.d.schema.items;
      const rows: Row[] = await tx
        .select({ id: items.id, name: items.name, sku: items.sku })
        .from(items)
        .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
      const byItem = new Map(rows.map((r) => [String(r['id']), r]));
      const out: GodownStockRow[] = [];
      const seen = new Set<string>();
      const push = (itemId: string, godownId: string, qty: number) => {
        const item = byItem.get(itemId);
        if (!item || seen.has(godownKey(itemId, godownId))) return;
        seen.add(godownKey(itemId, godownId));
        out.push({
          itemId,
          name: s(item['name']),
          sku: s(item['sku']),
          godownId,
          onHandMicros: qty,
          minMicros: levels.get(godownKey(itemId, godownId)) ?? 0,
        });
      };
      for (const [key, qty] of onHand) {
        const [itemId, godownId] = key.split('|');
        if (itemId && godownId) push(itemId, godownId, qty);
      }
      // a level set where there is no stock yet still shows, so a shortage is visible
      for (const [key] of levels) {
        const [itemId, godownId] = key.split('|');
        if (itemId && godownId) push(itemId, godownId, 0);
      }
      return out.sort(
        (a, b) => a.name.localeCompare(b.name) || a.godownId.localeCompare(b.godownId),
      );
    });
  }

  async levelsIn(tx: any, ctx: Ctx): Promise<Map<string, number>> {
    const t = this.d.schema.godown_levels;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
    return new Map(
      rows.map((r) => [
        godownKey(String(r['item_id']), String(r['godown_id'])),
        n(r['min_stock_micros']),
      ]),
    );
  }

  /** The reorder level of an item in one godown; zero removes it. */
  async setLevel(ctx: Ctx, itemId: string, godownId: string, minMicros: number): Promise<void> {
    if (!Number.isInteger(minMicros) || minMicros < 0)
      throw new RuleError('A reorder level is a whole quantity, zero or more.');
    await runInTx(this.d, ctx, async (tx) => {
      const levels = new BaseRepo(this.d, 'godown_levels');
      const t = this.d.schema.godown_levels;
      const [cur]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.item_id, itemId),
            eq(t.godown_id, godownId),
            isNull(t.deleted_at),
          ),
        )
        .limit(1);
      if (cur)
        await (levels as any).updateIn(
          tx,
          ctx,
          cur['id'],
          { min_stock_micros: minMicros },
          cur['version'],
        );
      else if (minMicros > 0)
        await (levels as any).createIn(tx, ctx, {
          item_id: itemId,
          godown_id: godownId,
          min_stock_micros: minMicros,
        });
    });
  }

  /** Items below the reorder level set for a godown, most short first. */
  async lowByGodown(ctx: Ctx): Promise<GodownStockRow[]> {
    return (await this.stock(ctx))
      .filter((r) => r.minMicros > 0 && r.onHandMicros < r.minMicros)
      .sort((a, b) => a.onHandMicros - a.minMicros - (b.onHandMicros - b.minMicros));
  }
}

/* ------------------------------------------------------------------ transfers */

export interface TransferLineInput {
  itemId: string;
  batchId?: string | null;
  serials?: readonly string[];
  qtyMicros: number;
}

export interface TransferInput {
  date: string;
  fromGodownId: string;
  toGodownId: string;
  note?: string;
  lines: TransferLineInput[];
  /** Dispatch and receive in one step. */
  immediate?: boolean;
  lockOverride?: LockOverride;
}

export interface TransferLine {
  id: string;
  itemId: string;
  name: string;
  sku: string;
  batchId: string | null;
  batchNo: string | null;
  serials: string[];
  qtyMicros: number;
}

export interface Transfer {
  id: string;
  number: string;
  date: string;
  receivedDate: string | null;
  fromGodownId: string;
  toGodownId: string;
  status: 'dispatched' | 'received' | 'cancelled';
  note: string;
  version: number;
  lines: TransferLine[];
}

export class TransferRepo extends BaseRepo {
  private readonly lines: BaseRepo;
  private readonly movements: BaseRepo;
  private readonly lock: PeriodLockRepo;

  constructor(d: Database) {
    super(d, 'stock_transfers');
    this.lines = new BaseRepo(d, 'stock_transfer_lines');
    this.movements = new BaseRepo(d, 'stock_movements');
    this.lock = new PeriodLockRepo(d);
  }

  private async nextNumberIn(tx: any, ctx: Ctx, date: string): Promise<string> {
    const c: Ctx = { ...ctx, tx };
    const b = await new BusinessRepo(this.d).get(c);
    const fy = fyOf(date, Number(b?.['fy_start_month'] ?? 4));
    const key = `inventory.transfer.number.${fy.label}`;
    const settings = new SettingsRepo(this.d);
    const next = Number((await settings.getValue<number>(c, key)) ?? 0) + 1;
    await settings.set(c, key, next);
    return `TR/${fy.label}/${String(next).padStart(4, '0')}`;
  }

  /** Dispatch stock from one godown to another; with `immediate` it arrives in the same transaction. */
  async dispatch(ctx: Ctx, input: TransferInput): Promise<Transfer> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new RuleError('Give the transfer a date.');
      if (input.fromGodownId === input.toGodownId)
        throw new RuleError('Choose two different godowns.');
      const godowns = await new GodownRepo(this.d).allIn(tx, ctx, { includeInactive: true });
      const from = godowns.find((g) => g.id === input.fromGodownId);
      const to = godowns.find((g) => g.id === input.toGodownId);
      if (!from || !to) throw new RuleError('Choose the godowns to move between.');
      if (!from.isActive || !to.isActive) throw new RuleError('An archived godown cannot be used.');
      if (input.lines.length === 0) throw new RuleError('Add at least one item to move.');
      const id = newId();
      await this.lock.assertOpen(
        c,
        input.date,
        { action: 'transfer stock', documentId: id },
        input.lockOverride,
      );

      const items = this.d.schema.items;
      const itemRows: Row[] = await tx
        .select()
        .from(items)
        .where(and(eq(items.business_id, ctx.businessId), isNull(items.deleted_at)));
      const byId = new Map(itemRows.map((r) => [String(r['id']), r]));
      const onHand = await onHandByGodownIn(this.d, tx, ctx, {
        itemIds: input.lines.map((l) => l.itemId),
        godownId: from.id,
      });
      const { batchOnHandIn, serialStatesIn } = await import('./batches');
      const batchStock = await batchOnHandIn(this.d, tx, ctx, {
        itemIds: input.lines.map((l) => l.itemId),
        godownId: from.id,
      });

      const number = await this.nextNumberIn(tx, ctx, input.date);
      const status = input.immediate ? 'received' : 'dispatched';
      const row = await this.createIn(tx, ctx, {
        id,
        number,
        from_godown_id: from.id,
        to_godown_id: to.id,
        status,
        date: input.date,
        received_date: input.immediate ? input.date : null,
        note: input.note?.trim() || null,
      });

      const need = new Map<string, number>();
      for (const l of input.lines) {
        const item = byId.get(l.itemId);
        if (!item) throw new NotFoundError('items', l.itemId);
        if (!item['track_stock']) throw new RuleError(`${item['name']} does not track stock.`);
        const mode = s(item['tracking_mode'] || 'none') as TrackingMode;
        const serials = l.serials ? parseSerials(l.serials.join('\n')).serials : [];
        let qty = l.qtyMicros;
        if (mode === 'serial') {
          if (serials.length === 0)
            throw new RuleError(`${item['name']}: list the serial numbers to move.`);
          qty = serials.length * 1_000_000;
          if (l.qtyMicros && !serialCountMatches(serials, l.qtyMicros))
            throw new RuleError(`${item['name']}: the quantity must equal the number of serials.`);
          const states = await serialStatesIn(this.d, tx, ctx, l.itemId, serials, from.id);
          const check = checkSerials(serials, states, 'out');
          if (check.unavailable.length > 0)
            throw new RuleError(
              `${item['name']}: not in ${from.name}: ${check.unavailable.slice(0, 5).join(', ')}`,
            );
        }
        if (!Number.isInteger(qty) || qty <= 0)
          throw new RuleError(`${item['name']}: give a quantity to move.`);
        if (mode === 'batch') {
          if (!l.batchId) throw new RuleError(`${item['name']}: choose the batch to move.`);
          const have = batchStock.get(`${l.itemId}|${l.batchId}`) ?? 0;
          if (have < qty)
            throw new RuleError(
              `${item['name']}: the batch has ${have / 1e6} in ${from.name}, not ${qty / 1e6}.`,
            );
        }
        need.set(l.itemId, (need.get(l.itemId) ?? 0) + qty);
        const have = onHand.get(godownKey(l.itemId, from.id)) ?? 0;
        if (need.get(l.itemId)! > have)
          throw new RuleError(
            `${item['name']}: ${from.name} has ${have / 1e6}, not ${need.get(l.itemId)! / 1e6}.`,
          );

        const line = await (this.lines as any).createIn(tx, ctx, {
          transfer_id: id,
          item_id: l.itemId,
          batch_id: mode === 'batch' ? l.batchId : null,
          serials_json: serials.length > 0 ? serials : null,
          qty_micros: qty,
        });
        await this.moveIn(tx, ctx, row, line, 'out', input.date);
        if (input.immediate) await this.moveIn(tx, ctx, row, line, 'in', input.date);
      }
      return (await this.getIn2(tx, ctx, id))!;
    });
  }

  /** One `transfer` movement for a line: out of the source, or into the destination. */
  private async moveIn(
    tx: any,
    ctx: Ctx,
    transfer: Row,
    line: Row,
    direction: 'in' | 'out',
    date: string,
  ): Promise<void> {
    const qty = n(line['qty_micros']);
    const godown = direction === 'out' ? transfer['from_godown_id'] : transfer['to_godown_id'];
    const movement = await (this.movements as any).createIn(tx, ctx, {
      item_id: line['item_id'],
      godown_id: godown,
      batch_id: line['batch_id'] ?? null,
      kind: 'transfer',
      qty_micros: direction === 'out' ? -qty : qty,
      rate_paise: null,
      transfer_id: transfer['id'],
      date,
      note: `${transfer['number']} ${direction === 'out' ? 'dispatched' : 'received'}`,
      serials_json: line['serials_json'] ?? null,
    });
    const serials = Array.isArray(line['serials_json']) ? (line['serials_json'] as string[]) : [];
    if (serials.length > 0) {
      const { placeSerialsIn } = await import('./batches');
      await placeSerialsIn(this.d, tx, ctx, {
        itemId: String(line['item_id']),
        serials,
        // in transit a serial is in nobody's godown; it is still in stock
        godownId: direction === 'out' ? null : String(godown),
        batchId: (line['batch_id'] as string | null) ?? null,
        status: 'in_stock',
        movementId: String(movement['id']),
      });
    }
  }

  /** Goods dispatched earlier have arrived. */
  async receive(ctx: Ctx, id: string, version: number, date: string): Promise<Transfer> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const t = await this.getIn(tx, ctx, id);
      if (!t) throw new NotFoundError('stock_transfers', id);
      if (t['status'] !== 'dispatched')
        throw new RuleError('Only a dispatched transfer can be received.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new RuleError('Give the date the goods arrived.');
      if (date < String(t['date']))
        throw new RuleError('Goods cannot arrive before they were dispatched.');
      await this.lock.assertOpen(c, date, { action: 'receive transfer', documentId: id });
      const lines = await this.linesIn(tx, ctx, id);
      for (const line of lines) await this.moveIn(tx, ctx, t, line, 'in', date);
      await this.updateIn(tx, ctx, id, { status: 'received', received_date: date }, version);
      return (await this.getIn2(tx, ctx, id))!;
    });
  }

  /** A dispatch that never left, or came back: the stock returns to the source godown. */
  async cancel(ctx: Ctx, id: string, version: number, reason: string): Promise<Transfer> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const t = await this.getIn(tx, ctx, id);
      if (!t) throw new NotFoundError('stock_transfers', id);
      if (t['status'] !== 'dispatched')
        throw new RuleError('Only a dispatched transfer can be cancelled.');
      if (!reason.trim()) throw new RuleError('Say why the transfer is cancelled.');
      await this.lock.assertOpen(c, String(t['date']), {
        action: 'cancel transfer',
        documentId: id,
      });
      const lines = await this.linesIn(tx, ctx, id);
      // back into the source: an `in` on the same transfer, dated the dispatch day
      const back = { ...t, to_godown_id: t['from_godown_id'] };
      for (const line of lines) await this.moveIn(tx, ctx, back, line, 'in', String(t['date']));
      await this.updateIn(
        tx,
        ctx,
        id,
        {
          status: 'cancelled',
          note: [s(t['note']), `Cancelled: ${reason.trim()}`].filter(Boolean).join(' · '),
        },
        version,
      );
      return (await this.getIn2(tx, ctx, id))!;
    });
  }

  private async linesIn(tx: any, ctx: Ctx, transferId: string): Promise<Row[]> {
    const t = this.d.schema.stock_transfer_lines;
    return tx
      .select()
      .from(t)
      .where(
        and(eq(t.business_id, ctx.businessId), eq(t.transfer_id, transferId), isNull(t.deleted_at)),
      )
      .orderBy(asc(t.created_at));
  }

  private async getIn2(tx: any, ctx: Ctx, id: string): Promise<Transfer | null> {
    const row = await this.getIn(tx, ctx, id);
    if (!row) return null;
    return (await this.viewsIn(tx, ctx, [row]))[0] ?? null;
  }

  private async viewsIn(tx: any, ctx: Ctx, rows: Row[]): Promise<Transfer[]> {
    if (rows.length === 0) return [];
    const lineRows = await queryRows(
      this.d,
      tx,
      sql`SELECT l.*, i.name AS item_name, i.sku AS item_sku, b.batch_no
          FROM stock_transfer_lines l
          JOIN items i ON i.id = l.item_id
          LEFT JOIN batches b ON b.id = l.batch_id
          WHERE l.business_id = ${ctx.businessId} AND l.deleted_at IS NULL
            AND l.transfer_id IN (${sql.join(
              rows.map((r) => sql`${r['id']}`),
              sql`, `,
            )})
          ORDER BY l.created_at`,
    );
    const byTransfer = new Map<string, TransferLine[]>();
    for (const l of lineRows) {
      const list = byTransfer.get(String(l['transfer_id'])) ?? [];
      const raw = l['serials_json'];
      const serials = Array.isArray(raw)
        ? (raw as string[])
        : typeof raw === 'string'
          ? ((JSON.parse(raw) as string[]) ?? [])
          : [];
      list.push({
        id: s(l['id']),
        itemId: s(l['item_id']),
        name: s(l['item_name']),
        sku: s(l['item_sku']),
        batchId: l['batch_id'] == null ? null : s(l['batch_id']),
        batchNo: l['batch_no'] == null ? null : s(l['batch_no']),
        serials,
        qtyMicros: n(l['qty_micros']),
      });
      byTransfer.set(String(l['transfer_id']), list);
    }
    return rows.map((r) => ({
      id: s(r['id']),
      number: s(r['number']),
      date: s(r['date']),
      receivedDate: r['received_date'] == null ? null : s(r['received_date']),
      fromGodownId: s(r['from_godown_id']),
      toGodownId: s(r['to_godown_id']),
      status: s(r['status']) as Transfer['status'],
      note: s(r['note']),
      version: n(r['version']),
      lines: byTransfer.get(s(r['id'])) ?? [],
    }));
  }

  async getTransfer(ctx: Ctx, id: string): Promise<Transfer | null> {
    return runInTx(this.d, ctx, (tx) => this.getIn2(tx, ctx, id));
  }

  async all(
    ctx: Ctx,
    opts: { status?: Transfer['status']; limit?: number } = {},
  ): Promise<Transfer[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT * FROM stock_transfers
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL
              ${opts.status ? sql`AND status = ${opts.status}` : sql``}
            ORDER BY date DESC, created_at DESC LIMIT ${opts.limit ?? 200}`,
      );
      return this.viewsIn(tx, ctx, rows as Row[]);
    });
  }

  /** What is on the road: dispatched and not yet received, per item. */
  async inTransit(ctx: Ctx): Promise<Map<string, number>> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT l.item_id, sum(l.qty_micros) AS v
            FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
            WHERE l.business_id = ${ctx.businessId} AND l.deleted_at IS NULL AND t.status = 'dispatched'
            GROUP BY l.item_id`,
      );
      return new Map(rows.map((r) => [String(r['item_id']), n(r['v'])]));
    });
  }
}
