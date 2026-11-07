/**
 * Batches and serial numbers (prompt 51, FR-111). A batch is a lot of one item with its own expiry
 * (and MRP); stock per batch is the sum of the movements that name it. A serial is one unit with a
 * row of its own that says whether it is in stock and where, kept current by the movements that carry
 * it, so finding one among a hundred thousand is an index lookup.
 */
import { daysUntil, type BatchStock, type SerialState } from '@gst/domain';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BaseRepo, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import { defaultGodownIdIn } from './godowns';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A JSON column as a list, whichever dialect answered (SQLite gives raw queries text). */
export const jsonList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return jsonList(JSON.parse(v));
    } catch {
      return [];
    }
  }
  return [];
};

export interface Batch {
  id: string;
  itemId: string;
  batchNo: string;
  mfgDate: string | null;
  expiryDate: string | null;
  mrpPaise: number | null;
  purchaseRatePaise: number | null;
  version: number;
}

export interface BatchView extends Batch {
  /** In the godown asked for, or in all of them. */
  onHandMicros: number;
}

export const toBatch = (r: Row): Batch => ({
  id: s(r['id']),
  itemId: s(r['item_id']),
  batchNo: s(r['batch_no']),
  mfgDate: r['mfg_date'] == null ? null : s(r['mfg_date']),
  expiryDate: r['expiry_date'] == null ? null : s(r['expiry_date']),
  mrpPaise: r['mrp_paise'] == null ? null : n(r['mrp_paise']),
  purchaseRatePaise: r['purchase_rate_paise'] == null ? null : n(r['purchase_rate_paise']),
  version: n(r['version']),
});

export const batchKey = (itemId: string, batchId: string | null): string =>
  `${itemId}|${batchId ?? ''}`;

/** Stock per item and batch, in one godown or all (transfers included: they move a batch too). */
export async function batchOnHandIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  opts: { itemIds?: readonly string[]; godownId?: string | null; upTo?: string } = {},
): Promise<Map<string, number>> {
  if (opts.itemIds && opts.itemIds.length === 0) return new Map();
  const only = opts.itemIds
    ? sql`AND m.item_id IN (${sql.join(
        opts.itemIds.map((i) => sql`${i}`),
        sql`, `,
      )})`
    : sql``;
  const fallback = opts.godownId ? await defaultGodownIdIn(d, tx, ctx) : null;
  const where = opts.godownId
    ? opts.godownId === fallback
      ? sql`AND (m.godown_id = ${opts.godownId} OR m.godown_id IS NULL)`
      : sql`AND m.godown_id = ${opts.godownId}`
    : sql``;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT m.item_id, m.batch_id, sum(m.qty_micros) AS v FROM stock_movements m
        WHERE m.business_id = ${ctx.businessId} AND m.deleted_at IS NULL ${only} ${where}
          ${opts.upTo ? sql`AND m.date <= ${opts.upTo}` : sql``}
        GROUP BY m.item_id, m.batch_id`,
  );
  return new Map(
    rows.map((r) => [
      batchKey(String(r['item_id']), r['batch_id'] == null ? null : String(r['batch_id'])),
      n(r['v']),
    ]),
  );
}

/** The batches of one item with stock, as the picker wants them. */
export async function batchAvailabilityIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  itemId: string,
  godownId: string | null,
): Promise<BatchStock[]> {
  const b = d.schema.batches;
  const rows: Row[] = await tx
    .select()
    .from(b)
    .where(and(eq(b.business_id, ctx.businessId), eq(b.item_id, itemId), isNull(b.deleted_at)));
  const onHand = await batchOnHandIn(d, tx, ctx, { itemIds: [itemId], godownId });
  return rows.map((r) => ({
    batchId: String(r['id']),
    batchNo: s(r['batch_no']),
    expiryDate: r['expiry_date'] == null ? null : s(r['expiry_date']),
    availableMicros: onHand.get(batchKey(itemId, String(r['id']))) ?? 0,
  }));
}

export interface ExpiringRow {
  batchId: string;
  itemId: string;
  itemName: string;
  sku: string;
  batchNo: string;
  expiryDate: string;
  onHandMicros: number;
  /** Negative once expired. */
  daysLeft: number;
}

export class BatchRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'batches');
  }

  async of(
    ctx: Ctx,
    itemId: string,
    opts: { godownId?: string | null } = {},
  ): Promise<BatchView[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows: Row[] = await tx
        .select()
        .from(this.t)
        .where(
          and(
            eq(this.t.business_id, ctx.businessId),
            eq(this.t.item_id, itemId),
            isNull(this.t.deleted_at),
          ),
        )
        .orderBy(asc(this.t.expiry_date), asc(this.t.batch_no));
      const onHand = await batchOnHandIn(this.d, tx, ctx, {
        itemIds: [itemId],
        godownId: opts.godownId ?? null,
      });
      return rows.map((r) => ({
        ...toBatch(r),
        onHandMicros: onHand.get(batchKey(itemId, String(r['id']))) ?? 0,
      }));
    });
  }

  async byId(ctx: Ctx, id: string): Promise<Batch | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const r = await this.getIn(tx, ctx, id);
      return r ? toBatch(r) : null;
    });
  }

  /** Find a batch of the item by number, or make it. */
  async ensure(
    ctx: Ctx,
    input: {
      itemId: string;
      batchNo: string;
      mfgDate?: string | null;
      expiryDate?: string | null;
      mrpPaise?: number | null;
      purchaseRatePaise?: number | null;
    },
  ): Promise<Batch> {
    return runInTx(this.d, ctx, async (tx) => {
      const batchNo = input.batchNo.trim();
      if (batchNo === '') throw new RuleError('Give the batch a number.');
      const items = this.d.schema.items;
      const [item]: Row[] = await tx
        .select()
        .from(items)
        .where(
          and(
            eq(items.id, input.itemId),
            eq(items.business_id, ctx.businessId),
            isNull(items.deleted_at),
          ),
        )
        .limit(1);
      if (!item) throw new NotFoundError('items', input.itemId);
      if (item['tracking_mode'] !== 'batch')
        throw new RuleError(`${item['name']} is not tracked by batch. Change its tracking first.`);
      const existing: Row[] = await tx
        .select()
        .from(this.t)
        .where(
          and(
            eq(this.t.business_id, ctx.businessId),
            eq(this.t.item_id, input.itemId),
            eq(this.t.batch_no, batchNo),
            isNull(this.t.deleted_at),
          ),
        )
        .limit(1);
      if (existing[0]) return toBatch(existing[0]);
      const mfg = input.mfgDate || null;
      const exp = input.expiryDate || null;
      if (mfg && !ISO.test(mfg)) throw new RuleError('The manufacturing date is not a date.');
      if (exp && !ISO.test(exp)) throw new RuleError('The expiry date is not a date.');
      if (mfg && exp && exp < mfg) throw new RuleError('A batch cannot expire before it was made.');
      if (item['expiry_required'] && !exp)
        throw new RuleError(`${item['name']} needs an expiry date on every batch.`);
      const row = await this.createIn(tx, ctx, {
        item_id: input.itemId,
        batch_no: batchNo,
        mfg_date: mfg,
        expiry_date: exp,
        mrp_paise: input.mrpPaise ?? null,
        purchase_rate_paise: input.purchaseRatePaise ?? null,
      });
      return toBatch(row);
    });
  }

  async edit(
    ctx: Ctx,
    id: string,
    patch: { mfgDate?: string | null; expiryDate?: string | null; mrpPaise?: number | null },
    version: number,
  ): Promise<Batch> {
    return runInTx(this.d, ctx, async (tx) => {
      const cur = await this.getIn(tx, ctx, id);
      if (!cur) throw new NotFoundError('batches', id);
      const values: Record<string, unknown> = {};
      const mfg =
        patch.mfgDate === undefined ? (cur['mfg_date'] as string | null) : patch.mfgDate || null;
      const exp =
        patch.expiryDate === undefined
          ? (cur['expiry_date'] as string | null)
          : patch.expiryDate || null;
      if (mfg && !ISO.test(mfg)) throw new RuleError('The manufacturing date is not a date.');
      if (exp && !ISO.test(exp)) throw new RuleError('The expiry date is not a date.');
      if (mfg && exp && exp < mfg) throw new RuleError('A batch cannot expire before it was made.');
      if (patch.mfgDate !== undefined) values['mfg_date'] = mfg;
      if (patch.expiryDate !== undefined) values['expiry_date'] = exp;
      if (patch.mrpPaise !== undefined) values['mrp_paise'] = patch.mrpPaise;
      return toBatch(await this.updateIn(tx, ctx, id, values, version));
    });
  }

  /** Batches with stock that expire within `withinDays` of `asOf`, or already have; soonest first. */
  async expiring(ctx: Ctx, asOf: string, withinDays: number): Promise<ExpiringRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT b.id, b.item_id, b.batch_no, b.expiry_date, i.name, coalesce(i.sku, '') AS sku,
                   coalesce(m.v, 0) AS on_hand
            FROM batches b
            JOIN items i ON i.id = b.item_id
            LEFT JOIN (
              SELECT batch_id, sum(qty_micros) AS v FROM stock_movements
              WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND batch_id IS NOT NULL
              GROUP BY batch_id
            ) m ON m.batch_id = b.id
            WHERE b.business_id = ${ctx.businessId} AND b.deleted_at IS NULL AND b.expiry_date IS NOT NULL
              AND i.deleted_at IS NULL
            ORDER BY b.expiry_date, i.name, b.batch_no`,
      );
      return rows
        .map((r) => ({
          batchId: s(r['id']),
          itemId: s(r['item_id']),
          itemName: s(r['name']),
          sku: s(r['sku']),
          batchNo: s(r['batch_no']),
          expiryDate: s(r['expiry_date']),
          onHandMicros: n(r['on_hand']),
          daysLeft: daysUntil(asOf, s(r['expiry_date'])),
        }))
        .filter((r) => r.onHandMicros > 0 && r.daysLeft <= withinDays);
    });
  }
}

/* ------------------------------------------------------------------ serials */

export interface Serial {
  id: string;
  itemId: string;
  serialNo: string;
  batchId: string | null;
  godownId: string | null;
  status: SerialState;
  lastMovementId: string | null;
}

const toSerial = (r: Row): Serial => ({
  id: s(r['id']),
  itemId: s(r['item_id']),
  serialNo: s(r['serial_no']),
  batchId: r['batch_id'] == null ? null : s(r['batch_id']),
  godownId: r['godown_id'] == null ? null : s(r['godown_id']),
  status: (s(r['status']) as SerialState) || 'in_stock',
  lastMovementId: r['last_movement_id'] == null ? null : s(r['last_movement_id']),
});

const CHUNK = 400;

/** The state of each serial of one item: in stock (in the godown, when one is named), out, or unknown. */
export async function serialStatesIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  itemId: string,
  serials: readonly string[],
  godownId?: string | null,
): Promise<Map<string, SerialState>> {
  const t = d.schema.serials;
  const out = new Map<string, SerialState>();
  const fallback = godownId ? await defaultGodownIdIn(d, tx, ctx) : null;
  for (let i = 0; i < serials.length; i += CHUNK) {
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.item_id, itemId),
          isNull(t.deleted_at),
          inArray(t.serial_no, serials.slice(i, i + CHUNK)),
        ),
      );
    for (const r of rows) {
      const st = toSerial(r);
      const here =
        !godownId || st.godownId === godownId || (st.godownId === null && godownId === fallback);
      out.set(st.serialNo, st.status === 'in_stock' && here ? 'in_stock' : 'out');
    }
  }
  return out;
}

/**
 * Record where a list of serials is after a movement: made on first sight, otherwise updated. An
 * `out` leaves the row with its last godown, so a return can put it back where it was.
 */
export async function placeSerialsIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  input: {
    itemId: string;
    serials: readonly string[];
    godownId: string | null;
    batchId: string | null;
    status: SerialState;
    movementId: string;
  },
): Promise<void> {
  if (input.serials.length === 0) return;
  const repo = new BaseRepo(d, 'serials');
  const t = d.schema.serials;
  const existing = new Map<string, Row>();
  for (let i = 0; i < input.serials.length; i += CHUNK) {
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.item_id, input.itemId),
          isNull(t.deleted_at),
          inArray(t.serial_no, input.serials.slice(i, i + CHUNK)),
        ),
      );
    for (const r of rows) existing.set(String(r['serial_no']), r);
  }
  for (const serial of input.serials) {
    const cur = existing.get(serial);
    const values = {
      status: input.status,
      godown_id: input.status === 'out' ? (cur?.['godown_id'] ?? input.godownId) : input.godownId,
      batch_id: input.batchId ?? cur?.['batch_id'] ?? null,
      last_movement_id: input.movementId,
    };
    if (cur) await (repo as any).updateIn(tx, ctx, cur['id'], values, cur['version']);
    else
      await (repo as any).createIn(tx, ctx, {
        item_id: input.itemId,
        serial_no: serial,
        ...values,
      });
  }
}

export class SerialRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'serials');
  }

  /** One serial of an item, by its number: an index lookup. */
  async pick(ctx: Ctx, itemId: string, serialNo: string): Promise<Serial | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const [row]: Row[] = await tx
        .select()
        .from(this.t)
        .where(
          and(
            eq(this.t.business_id, ctx.businessId),
            eq(this.t.item_id, itemId),
            eq(this.t.serial_no, serialNo.trim()),
            isNull(this.t.deleted_at),
          ),
        )
        .limit(1);
      return row ? toSerial(row) : null;
    });
  }

  /** A serial by number across items (a scan at the counter does not know the item yet). */
  async find(ctx: Ctx, serialNo: string): Promise<Serial[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows: Row[] = await tx
        .select()
        .from(this.t)
        .where(
          and(
            eq(this.t.business_id, ctx.businessId),
            eq(this.t.serial_no, serialNo.trim()),
            isNull(this.t.deleted_at),
          ),
        )
        .limit(20);
      return rows.map(toSerial);
    });
  }

  async states(
    ctx: Ctx,
    itemId: string,
    serials: readonly string[],
    godownId?: string | null,
  ): Promise<Map<string, SerialState>> {
    return runInTx(this.d, ctx, (tx) => serialStatesIn(this.d, tx, ctx, itemId, serials, godownId));
  }

  async of(
    ctx: Ctx,
    itemId: string,
    opts: { status?: SerialState; godownId?: string | null; limit?: number } = {},
  ): Promise<Serial[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT * FROM serials
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND item_id = ${itemId}
              ${opts.status ? sql`AND status = ${opts.status}` : sql``}
              ${opts.godownId ? sql`AND godown_id = ${opts.godownId}` : sql``}
            ORDER BY serial_no LIMIT ${opts.limit ?? 500}`,
      );
      return (rows as Row[]).map(toSerial);
    });
  }

  /** How many of an item's serials are in stock, per godown. */
  async countInStock(ctx: Ctx, itemId: string): Promise<Map<string | null, number>> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT godown_id, count(*) AS c FROM serials
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND item_id = ${itemId}
              AND status = 'in_stock' GROUP BY godown_id`,
      );
      return new Map(
        rows.map((r) => [r['godown_id'] == null ? null : String(r['godown_id']), n(r['c'])]),
      );
    });
  }

  /** Every movement that carried a serial, newest first. */
  async history(
    ctx: Ctx,
    itemId: string,
    serialNo: string,
  ): Promise<
    {
      id: string;
      date: string;
      kind: string;
      qtyMicros: number;
      note: string;
      documentId: string | null;
    }[]
  > {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT id, date, kind, qty_micros, note, document_id, serials_json FROM stock_movements
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND item_id = ${itemId}
              AND serials_json IS NOT NULL
            ORDER BY date DESC, created_at DESC`,
      );
      const wanted = serialNo.trim();
      return rows
        .filter((r) => jsonList(r['serials_json']).includes(wanted))
        .map((r) => ({
          id: s(r['id']),
          date: s(r['date']),
          kind: s(r['kind']),
          qtyMicros: n(r['qty_micros']),
          note: s(r['note']),
          documentId: r['document_id'] == null ? null : s(r['document_id']),
        }));
    });
  }
}
