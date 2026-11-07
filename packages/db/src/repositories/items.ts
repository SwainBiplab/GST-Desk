/**
 * Items, units and saved import mappings. The item rules (what a valid item is) live in
 * `@gst/domain`; this file enforces them at the storage boundary, keeps SKU and barcode unique,
 * records whether an item's GST rate follows the HSN master, and posts opening stock.
 */
import {
  divRound,
  headerSignature,
  isUqc,
  uqcName,
  validateCustomUnit,
  validateItemInput,
  type BulkPlanEntry,
  type ItemFields,
  type SavedMapping,
} from '@gst/domain';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';

import type { Database } from '../database';
import { noteWrite } from '../events';
import type { NewRow, Row } from '../schema';

import {
  BaseRepo,
  ImportCancelled,
  NotFoundError,
  RuleError,
  ftsIds,
  newId,
  runInTx,
  writeAudit,
  type Ctx,
} from './base';
import { loadHsnResolver, lookupHsn, type HsnResolver } from './hsn-master';
import { onHandIn } from './inventory';
import { postStockVoucherIn, stockLines, valuationIn } from './stock-ledger';

const today = () => new Date().toISOString().slice(0, 10);

/** An item failed validation. `fields` maps a field name to a code the UI turns into a message. */
export class ItemValidationError extends RuleError {
  override name = 'ItemValidationError';
  constructor(
    readonly fields: Record<string, string>,
    /** Zero-based position in a bulk import, when known. */
    readonly index?: number,
  ) {
    super(
      `item rejected${index === undefined ? '' : ` (row ${index + 1})`}: ${Object.entries(fields)
        .map(([k, v]) => `${k} (${v})`)
        .join(', ')}`,
    );
  }
}

export interface BulkBatch {
  id: string;
  entries: { id: string; before: Record<string, unknown>; afterVersion: number }[];
}

/** What a merge moved, so a person can see (and a later release could undo) what it did. */
export interface ItemMergeRecord {
  sourceId: string;
  targetId: string;
  moved: {
    document_lines: string[];
    stock_movements: string[];
    batches: string[];
    item_variants: string[];
    attachments: string[];
  };
  sourceBefore: Row;
  targetBefore: Row;
}

export interface RateChangeRow {
  id: string;
  name: string;
  hsn: string;
  version: number;
  oldRateBp: number;
  newRateBp: number;
  oldCessBp: number;
  newCessBp: number;
  effectiveFrom: string;
  /** True when the new rate is already in force; false when it starts later. */
  due: boolean;
}

const TEXT_KEYS = ['name', 'sku', 'barcode', 'hsn', 'description'] as const;

/** Trim text, turn blanks into null, tidy tags. Only touches keys that are present. */
function normalise(v: NewRow): NewRow {
  const out: NewRow = { ...v };
  for (const k of TEXT_KEYS) {
    if (k in out && typeof out[k] === 'string') {
      const t = (out[k] as string).trim();
      out[k] = k === 'name' ? t : t === '' ? null : t;
    }
  }
  if (out['hsn']) out['hsn'] = String(out['hsn']).replace(/\s+/g, '');
  if (Array.isArray(out['tags_json'])) {
    const seen = new Set<string>();
    out['tags_json'] = (out['tags_json'] as string[])
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter((t) => t !== '' && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  }
  return out;
}

const fieldsOf = (r: Row): ItemFields => r as unknown as ItemFields;

function overriddenFlag(resolver: Pick<HsnResolver, 'resolve'>, row: Row, asOf: string): boolean {
  if (!row['hsn']) return false;
  const master = resolver.resolve(String(row['hsn']), asOf);
  return !!master && master.rate_bp !== Number(row['gst_rate_bp'] ?? 0);
}

export class ItemRepo extends BaseRepo {
  private readonly movements: BaseRepo;

  constructor(d: Database) {
    super(d, 'items');
    this.movements = new BaseRepo(d, 'stock_movements');
  }

  async search(ctx: Ctx, q: string, limit = 20): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      this.byIds(tx, ctx, await ftsIds(this.d, tx, ctx, 'items', q, limit)),
    );
  }

  /** Several items by id, in the order asked. Missing or deleted ids are left out. */
  async getMany(ctx: Ctx, ids: readonly string[]): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        out.push(...(await this.byIds(tx, ctx, ids.slice(i, i + 500))));
      }
      return out;
    });
  }

  /** Every SKU and barcode in use, for checking an import file before it is written. */
  async existingKeys(ctx: Ctx): Promise<{ skus: string[]; barcodes: string[] }> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const rows: Row[] = await tx
        .select({ sku: t.sku, barcode: t.barcode })
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
      return {
        skus: rows.map((r) => r['sku']).filter((x): x is string => !!x),
        barcodes: rows.map((r) => r['barcode']).filter((x): x is string => !!x),
      };
    });
  }

  /** The live items that already use this SKU or barcode. */
  async findClashes(
    ctx: Ctx,
    keys: { sku?: string | null; barcode?: string | null },
    ignoreId?: string,
  ): Promise<{ sku: Row | null; barcode: Row | null }> {
    return runInTx(this.d, ctx, (tx) => this.clashesIn(tx, ctx, keys, ignoreId));
  }

  private async clashesIn(
    tx: any,
    ctx: Ctx,
    keys: { sku?: string | null; barcode?: string | null },
    ignoreId?: string,
  ) {
    const t = this.t;
    const by = [
      keys.sku ? eq(t.sku, keys.sku) : undefined,
      keys.barcode ? eq(t.barcode, keys.barcode) : undefined,
    ].filter(Boolean);
    if (by.length === 0) return { sku: null, barcode: null };
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          isNull(t.deleted_at),
          ignoreId ? ne(t.id, ignoreId) : undefined,
          or(...by),
        ),
      );
    return {
      sku: (keys.sku && rows.find((r) => r['sku'] === keys.sku)) || null,
      barcode: (keys.barcode && rows.find((r) => r['barcode'] === keys.barcode)) || null,
    };
  }

  private async unitsMissingIn(
    tx: any,
    ctx: Ctx,
    ids: (string | null | undefined)[],
  ): Promise<boolean> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (wanted.length === 0) return false;
    const u = this.d.schema.units;
    const rows: Row[] = await tx
      .select({ id: u.id })
      .from(u)
      .where(and(eq(u.business_id, ctx.businessId), isNull(u.deleted_at), inArray(u.id, wanted)));
    return rows.length !== wanted.length;
  }

  /** Validate and complete a row about to be stored. `only` limits error reporting to changed fields. */
  private async prepareIn(
    tx: any,
    ctx: Ctx,
    merged: NewRow,
    patch: NewRow | null,
    ignoreId?: string,
  ): Promise<NewRow> {
    const errors: Record<string, string> = {};
    const found = validateItemInput(fieldsOf(merged));
    for (const [k, v] of Object.entries(found)) if (!patch || k in patch) errors[k] = v;

    if (!patch || 'sku' in patch || 'barcode' in patch) {
      const clash = await this.clashesIn(
        tx,
        ctx,
        {
          sku: (merged['sku'] as string | null) ?? null,
          barcode: (merged['barcode'] as string | null) ?? null,
        },
        ignoreId,
      );
      if (clash.sku) errors['sku'] = 'duplicate_sku';
      if (clash.barcode) errors['barcode'] = 'duplicate_barcode';
    }
    if (!patch || 'unit_id' in patch || 'secondary_unit_id' in patch) {
      if (await this.unitsMissingIn(tx, ctx, [merged['unit_id'], merged['secondary_unit_id']]))
        errors['unit_id'] = 'unit';
    }
    // how units are told apart (prompt 51): batches or serials need stock tracking, expiry needs batches
    const mode = String(merged['tracking_mode'] ?? 'none') || 'none';
    if (!['none', 'batch', 'serial'].includes(mode)) errors['tracking_mode'] = 'tracking_mode';
    else if (mode !== 'none' && !merged['track_stock']) errors['tracking_mode'] = 'tracking_mode';
    if (merged['expiry_required'] && mode !== 'batch') errors['expiry_required'] = 'tracking_mode';
    if (patch && 'tracking_mode' in patch && ignoreId) {
      const before = await this.getIn(tx, ctx, ignoreId);
      const was = String(before?.['tracking_mode'] ?? 'none') || 'none';
      if (before && was !== mode) {
        const onHand = (await onHandIn(this.d, tx, ctx, [ignoreId])).get(ignoreId) ?? 0;
        if (onHand !== 0) errors['tracking_mode'] = 'tracking_change';
      }
    }
    if (merged['default_godown_id']) {
      const g = this.d.schema.godowns;
      const [godown]: Row[] = await tx
        .select({ id: g.id })
        .from(g)
        .where(
          and(
            eq(g.id, String(merged['default_godown_id'])),
            eq(g.business_id, ctx.businessId),
            isNull(g.deleted_at),
          ),
        )
        .limit(1);
      if (!godown) errors['default_godown_id'] = 'godown';
    }
    if (Object.keys(errors).length > 0) throw new ItemValidationError(errors);

    const out: NewRow = patch ? { ...patch } : { ...merged };
    if (!patch || 'hsn' in patch || 'gst_rate_bp' in patch) {
      const master = merged['hsn']
        ? await lookupHsn(this.d, String(merged['hsn']), today(), tx)
        : null;
      out['gst_rate_overridden'] =
        !!master && master.rate_bp !== Number(merged['gst_rate_bp'] ?? 0);
    }
    return out;
  }

  override async create(
    ctx: Ctx,
    values: NewRow & { id?: string },
    opts: { openingDate?: string } = {},
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const clean = normalise(values);
      const row = await this.prepareIn(tx, ctx, clean, null);
      const created = await this.createIn(tx, ctx, row);
      await this.postOpeningStockIn(tx, ctx, [created], opts.openingDate ?? today());
      return created;
    });
  }

  override async update(
    ctx: Ctx,
    id: string,
    patch: NewRow,
    expectedVersion: number,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const before = await this.getIn(tx, ctx, id);
      if (!before) throw new NotFoundError(this.name, id);
      const clean = normalise(patch);
      const merged = { ...before, ...clean };
      const row = await this.prepareIn(tx, ctx, merged, clean, id);
      return this.updateIn(tx, ctx, id, row, expectedVersion);
    });
  }

  /** Stock-in movements for items created with an opening quantity. */
  private async postOpeningStockIn(tx: any, ctx: Ctx, items: Row[], date: string): Promise<void> {
    const opening = items.filter((i) => i['track_stock'] && Number(i['opening_stock_micros']) > 0);
    if (opening.length === 0) return;
    const g = this.d.schema.godowns;
    const [godown]: Row[] = await tx
      .select({ id: g.id })
      .from(g)
      .where(and(eq(g.business_id, ctx.businessId), eq(g.is_default, true), isNull(g.deleted_at)))
      .limit(1);
    const valuation = await valuationIn(this.d, tx, ctx);
    const written: { id: string; version: number }[] = [];
    let total = 0n;
    for (const i of opening) {
      const qty = BigInt(i['opening_stock_micros']);
      const value = BigInt(i['opening_stock_value_paise'] ?? 0);
      const rate =
        value > 0n ? divRound(value * 1_000_000n, qty) : BigInt(i['purchase_rate_paise'] ?? 0);
      const cost = value > 0n ? value : divRound(rate * qty, 1_000_000n);
      const row = await (this.movements as any).createIn(tx, ctx, {
        item_id: i['id'],
        godown_id: i['default_godown_id'] ?? godown?.['id'] ?? null,
        kind: 'in',
        qty_micros: Number(qty),
        rate_paise: Number(rate),
        cost_paise: Number(cost),
        date,
        note: 'Opening stock',
      });
      written.push({ id: String(row['id']), version: Number(row['version']) });
      total += cost;
    }
    if (valuation && total > 0n) {
      // opening stock is the owner's, so it balances through Opening Balance Equity
      const narration = `Opening stock: ${opening
        .map((i) => i['name'])
        .slice(0, 3)
        .join(', ')}${opening.length > 3 ? ', …' : ''}`;
      const voucherId = await postStockVoucherIn(this.d, tx, ctx, {
        date,
        narration,
        lines: stockLines('in', total, 'openingEquity', narration),
      });
      for (const w of written)
        await (this.movements as any).updateIn(tx, ctx, w.id, { voucher_id: voucherId }, w.version);
    }
  }

  /**
   * Create many items in one transaction: either all are stored or none. Validates every row first,
   * writes in chunks, reports progress, and stops cleanly if `shouldCancel` returns true.
   */
  async bulkCreate(
    ctx: Ctx,
    rows: NewRow[],
    opts: {
      onProgress?: (done: number, total: number) => void | Promise<void>;
      shouldCancel?: () => boolean;
      openingDate?: string;
      chunk?: number;
    } = {},
  ): Promise<{ created: number }> {
    return runInTx(this.d, ctx, async (tx) => {
      const s = this.d.schema;
      const total = rows.length;
      const chunk = opts.chunk ?? 200;

      const resolver = await loadHsnResolver(this.d, tx);
      const existing: Row[] = await tx
        .select({ sku: s.items.sku, barcode: s.items.barcode })
        .from(s.items)
        .where(and(eq(s.items.business_id, ctx.businessId), isNull(s.items.deleted_at)));
      const skus = new Set(existing.map((r) => r['sku']).filter(Boolean));
      const barcodes = new Set(existing.map((r) => r['barcode']).filter(Boolean));
      const unitRows: Row[] = await tx
        .select({ id: s.units.id })
        .from(s.units)
        .where(and(eq(s.units.business_id, ctx.businessId), isNull(s.units.deleted_at)));
      const units = new Set(unitRows.map((r) => r['id']));

      const clean: NewRow[] = rows.map((r, index) => {
        const v = normalise(r);
        const errors: Record<string, string> = { ...validateItemInput(fieldsOf(v)) };
        const sku = v['sku'] as string | null | undefined;
        const barcode = v['barcode'] as string | null | undefined;
        if (sku) {
          if (skus.has(sku)) errors['sku'] = 'duplicate_sku';
          skus.add(sku);
        }
        if (barcode) {
          if (barcodes.has(barcode)) errors['barcode'] = 'duplicate_barcode';
          barcodes.add(barcode);
        }
        for (const k of ['unit_id', 'secondary_unit_id']) {
          if (v[k] && !units.has(v[k])) errors['unit_id'] = 'unit';
        }
        if (Object.keys(errors).length > 0) throw new ItemValidationError(errors, index);
        return { ...v, gst_rate_overridden: overriddenFlag(resolver, v, today()) };
      });

      const date = opts.openingDate ?? today();
      let done = 0;
      for (let i = 0; i < clean.length; i += chunk) {
        if (opts.shouldCancel?.()) throw new ImportCancelled();
        const now = Date.now();
        const slice = clean.slice(i, i + chunk).map((v) => ({
          ...v,
          id: newId(),
          org_id: ctx.orgId,
          business_id: ctx.businessId,
          version: 1,
          created_at: now,
          updated_at: now,
          created_by: ctx.actor,
          updated_by: ctx.actor,
        }));
        const created: Row[] = await tx.insert(s.items).values(slice).returning();
        noteWrite(tx, 'items');
        noteWrite(tx, 'audit_log');
        await tx.insert(s.audit_log).values(
          created.map((row) => ({
            id: newId(),
            org_id: ctx.orgId,
            business_id: ctx.businessId,
            created_at: now,
            table_name: 'items',
            row_id: row['id'],
            action: 'insert',
            before_json: null,
            after_json: row,
            actor: ctx.actor,
            device_id: ctx.deviceId,
            at: now,
          })),
        );
        await this.postOpeningStockIn(tx, ctx, created, date);
        done += slice.length;
        await opts.onProgress?.(done, total);
      }
      if (opts.shouldCancel?.()) throw new ImportCancelled();
      return { created: done };
    });
  }

  /**
   * Apply a bulk-edit plan (from `planBulkEdit`) in one transaction. Fails as a whole with a
   * `ConflictError` if any item changed since the plan was made. The returned batch undoes it.
   */
  async applyBulkEdit(ctx: Ctx, plan: readonly BulkPlanEntry[]): Promise<BulkBatch> {
    return runInTx(this.d, ctx, async (tx) => {
      const resolver = await loadHsnResolver(this.d, tx);
      const entries: BulkBatch['entries'] = [];
      for (const e of plan) {
        if (e.skipped) continue;
        const before = await this.getIn(tx, ctx, e.id);
        if (!before) throw new NotFoundError(this.name, e.id);
        const after: NewRow = { ...e.after };
        const undo: Record<string, unknown> = { ...e.before };
        if ('gst_rate_bp' in after) {
          const flag = overriddenFlag(resolver, { ...before, ...after }, today());
          after['gst_rate_overridden'] = flag;
          undo['gst_rate_overridden'] = before['gst_rate_overridden'];
        }
        const row = await this.updateIn(tx, ctx, e.id, after, e.version);
        entries.push({ id: e.id, before: undo, afterVersion: Number(row['version']) });
      }
      return { id: newId(), entries };
    });
  }

  /** Put back what a bulk edit changed. Items edited since are left alone and counted as skipped. */
  async undoBulkEdit(ctx: Ctx, batch: BulkBatch): Promise<{ reverted: number; skipped: number }> {
    return runInTx(this.d, ctx, async (tx) => {
      let reverted = 0;
      let skipped = 0;
      for (const e of batch.entries) {
        const now = await this.getIn(tx, ctx, e.id);
        if (!now || Number(now['version']) !== e.afterVersion) {
          skipped++;
          continue;
        }
        await this.updateIn(tx, ctx, e.id, e.before as NewRow, e.afterVersion);
        reverted++;
      }
      return { reverted, skipped };
    });
  }

  /**
   * Items whose rate no longer matches the HSN master. Items with a deliberate override are not
   * listed. `due` is false for changes that start in the future.
   */
  async rateChanges(ctx: Ctx, asOf = today()): Promise<RateChangeRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const items: Row[] = await tx
        .select({
          id: t.id,
          name: t.name,
          hsn: t.hsn,
          version: t.version,
          gst_rate_bp: t.gst_rate_bp,
          cess_bp: t.cess_bp,
        })
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            isNull(t.deleted_at),
            eq(t.gst_rate_overridden, false),
          ),
        );
      const resolver = await loadHsnResolver(this.d, tx);
      const out: RateChangeRow[] = [];
      for (const it of items) {
        if (!it['hsn']) continue;
        const hsn = String(it['hsn']);
        const now = resolver.resolve(hsn, asOf);
        const next = resolver.upcoming(hsn, asOf);
        const rate = Number(it['gst_rate_bp']);
        const cess = Number(it['cess_bp']);
        const differs = (r: { rate_bp: number; cess_bp: number }) =>
          r.rate_bp !== rate || r.cess_bp !== cess;
        const target = now && differs(now) ? now : next && differs(next) ? next : null;
        if (!target) continue;
        out.push({
          id: it['id'],
          name: it['name'],
          hsn,
          version: Number(it['version']),
          oldRateBp: rate,
          newRateBp: target.rate_bp,
          oldCessBp: cess,
          newCessBp: target.cess_bp,
          effectiveFrom: target.effective_from,
          due: target.effective_from <= asOf,
        });
      }
      return out.sort((a, b) => a.hsn.localeCompare(b.hsn) || a.name.localeCompare(b.name));
    });
  }

  /**
   * Fold `source` into `target`: its lines on documents, stock movements, batches, variants and files
   * move to the target, empty fields on the target are filled from it, and the source is archived. One
   * transaction, every moved row audited. Stock is the sum of movements, so the target now holds both
   * stocks. Items of different kinds (goods and a service) are not merged.
   */
  async merge(ctx: Ctx, sourceId: string, targetId: string): Promise<ItemMergeRecord> {
    if (sourceId === targetId) throw new RuleError('cannot merge an item into itself');
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const source = await this.getIn(tx, ctx, sourceId);
      const target = await this.getIn(tx, ctx, targetId);
      if (!source) throw new NotFoundError('items', sourceId);
      if (!target) throw new NotFoundError('items', targetId);
      if (source['kind'] !== target['kind'])
        throw new RuleError('a product and a service cannot be merged');

      const moved: ItemMergeRecord['moved'] = {
        document_lines: [],
        stock_movements: [],
        batches: [],
        item_variants: [],
        attachments: [],
      };
      for (const table of Object.keys(moved) as (keyof typeof moved)[]) {
        const t = this.d.schema[table];
        const col = table === 'attachments' ? 'owner_id' : 'item_id';
        const where =
          table === 'attachments'
            ? and(
                eq(t.business_id, ctx.businessId),
                eq(t.owner_table, 'items'),
                eq(t.owner_id, sourceId),
              )
            : and(eq(t.business_id, ctx.businessId), eq(t[col], sourceId));
        const rows: Row[] = await tx.select().from(t).where(where);
        for (const r of rows) {
          const [after]: Row[] = await tx
            .update(t)
            .set({ [col]: targetId })
            .where(eq(t.id, r['id']))
            .returning();
          noteWrite(tx, table);
          await writeAudit(this.d, tx, c, table, String(r['id']), 'update', r, after ?? null);
          moved[table].push(String(r['id']));
        }
      }

      // free the source's SKU and barcode so the target can take them if it has none
      const fill: NewRow = {};
      const clear: NewRow = {};
      for (const f of ['barcode', 'sku'] as const) {
        if (source[f]) {
          clear[f] = null;
          if (!target[f]) fill[f] = source[f];
        }
      }
      if (Object.keys(clear).length > 0) await this.update(c, sourceId, clear, source['version']);
      for (const f of ['hsn', 'description', 'unit_id', 'mrp_paise'] as const)
        if (!target[f] && source[f]) fill[f] = source[f];
      for (const f of ['sale_rate_paise', 'purchase_rate_paise'] as const)
        if (!Number(target[f]) && Number(source[f])) fill[f] = source[f];
      if (source['track_stock'] && !target['track_stock']) fill['track_stock'] = true;
      fill['min_stock_micros'] = Math.max(
        Number(target['min_stock_micros'] ?? 0),
        Number(source['min_stock_micros'] ?? 0),
      );
      const tags = [...new Set([...(target['tags_json'] ?? []), ...(source['tags_json'] ?? [])])];
      if (tags.length > (target['tags_json'] ?? []).length) fill['tags_json'] = tags;
      await this.update(c, targetId, fill, target['version']);

      const sourceNow = (await this.getIn(tx, ctx, sourceId))!;
      await this.softDelete(c, sourceId, sourceNow['version']);
      return { sourceId, targetId, moved, sourceBefore: source, targetBefore: target };
    });
  }

  protected override async beforeSoftDelete(ctx: Ctx, tx: any, row: Row) {
    for (const [table, col] of [
      ['document_lines', 'item_id'],
      ['stock_movements', 'item_id'],
    ] as const) {
      if (await this.isReferenced(tx, ctx, table, col, row['id'])) {
        throw new RuleError(`item ${row['id']} is referenced by ${table} and cannot be deleted`);
      }
    }
  }
}

/** Units of measure: the standard UQC set a business picks from, and its own custom units. */
export class UnitRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'units');
  }

  /** Add a standard GST unit (by its UQC code) to this business. A no-op if it is already there. */
  async addStandard(ctx: Ctx, code: string): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      if (!isUqc(code)) throw new RuleError(`${code} is not a GST unit quantity code`);
      const t = this.t;
      const [have]: Row[] = await tx
        .select()
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), eq(t.code, code), isNull(t.deleted_at)))
        .limit(1);
      if (have) return have;
      return this.createIn(tx, ctx, { code, name: uqcName(code)!, is_custom: false, uqc: code });
    });
  }

  /** Add a custom unit mapped to the UQC it reports as in returns. */
  async addCustom(ctx: Ctx, input: { code: string; name: string; uqc: string }): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const existing: Row[] = await tx
        .select({ code: t.code })
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
      const problems = validateCustomUnit(
        input,
        existing.map((r) => r['code']),
      );
      if (problems.length > 0) throw new RuleError(`unit rejected: ${problems.join(', ')}`);
      return this.createIn(tx, ctx, {
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        is_custom: true,
        uqc: input.uqc,
      });
    });
  }

  protected override async beforeSoftDelete(ctx: Ctx, tx: any, row: Row) {
    for (const [table, col] of [
      ['items', 'unit_id'],
      ['items', 'secondary_unit_id'],
      ['document_lines', 'unit_id'],
    ] as const) {
      if (await this.isReferenced(tx, ctx, table, col, row['id'])) {
        throw new RuleError(`unit ${row['code']} is in use and cannot be removed`);
      }
    }
  }
}

/** Column mappings the user saved for an import, found again by header layout. */
export class ImportMappingRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'import_mappings');
  }

  async forHeaders(
    ctx: Ctx,
    entity: 'items' | 'parties',
    headers: readonly string[],
  ): Promise<SavedMapping | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const [row]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.entity, entity),
            eq(t.signature, headerSignature(headers)),
            isNull(t.deleted_at),
          ),
        )
        .limit(1);
      return (row?.['mapping_json'] as SavedMapping | undefined) ?? null;
    });
  }

  async save(
    ctx: Ctx,
    entity: 'items' | 'parties',
    headers: readonly string[],
    mapping: SavedMapping,
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const signature = headerSignature(headers);
      const [row]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.entity, entity),
            eq(t.signature, signature),
            isNull(t.deleted_at),
          ),
        )
        .limit(1);
      if (row) await this.updateIn(tx, ctx, row['id'], { mapping_json: mapping }, row['version']);
      else await this.createIn(tx, ctx, { entity, signature, mapping_json: mapping });
    });
  }
}
