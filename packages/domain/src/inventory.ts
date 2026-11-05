/**
 * Basic inventory rules (prompt 19, FR-110). Pure functions: which documents move stock and which way,
 * what a negative-stock policy decides, and how a physical count sheet becomes adjustments. The
 * repository stores what these decide. Quantities are integers in millionths of a unit.
 */
import { parseCsv, parseQtyMicros, toCsv, type CsvValue } from './csv';
import { stockEffect } from './documents/rules';
import type { DocumentType } from './turnover';

/* ------------------------------------------------------------------ what moves stock */

export type StockDirection = 'in' | 'out';

/** Settings a document carries that decide whether it moves stock. */
export interface StockOptions {
  /** A delivery challan takes stock out only when asked to. */
  reduceStock?: boolean | null | undefined;
}

/**
 * The movement a document causes when issued, or `null` for none. A tax invoice, bill of supply,
 * debit note and purchase return take stock out; a purchase bill and credit note bring it in; a
 * delivery challan takes it out only when it is set to (and is then usually marked returnable).
 * Quotations, proformas, receipts and expenses never move stock.
 */
export function stockEffectOf(type: DocumentType, opts: StockOptions = {}): StockDirection | null {
  if (type === 'delivery_challan') return opts.reduceStock ? 'out' : null;
  return stockEffect(type);
}

/** The signed quantity a line adds to stock: negative for `out`. */
export const signedQty = (direction: StockDirection, qtyMicros: number): number =>
  direction === 'out' ? -qtyMicros : qtyMicros;

/** Why a manual adjustment was made. */
export const ADJUST_REASONS = [
  'count',
  'damage',
  'loss',
  'found',
  'correction',
  'opening',
  'other',
] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];
export const isAdjustReason = (v: string): v is AdjustReason =>
  (ADJUST_REASONS as readonly string[]).includes(v);

/* ------------------------------------------------------------------ negative stock */

/** `allow`: issue and warn. `block`: refuse to issue a document that would take stock below zero. */
export type StockPolicy = 'allow' | 'block';
export const DEFAULT_STOCK_POLICY: StockPolicy = 'allow';
export const isStockPolicy = (v: unknown): v is StockPolicy => v === 'allow' || v === 'block';

export interface StockNeed {
  itemId: string;
  name: string;
  onHandMicros: number;
  /** How much the document takes out. */
  needMicros: number;
}

export interface Shortfall {
  itemId: string;
  name: string;
  onHandMicros: number;
  needMicros: number;
  /** What would be left: below zero. */
  afterMicros: number;
}

/** Add up the quantity per item over document lines (an item can be on several lines). */
export function sumByItem(
  lines: readonly { itemId: string | null | undefined; qtyMicros: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!l.itemId) continue;
    out.set(l.itemId, (out.get(l.itemId) ?? 0) + l.qtyMicros);
  }
  return out;
}

/** The items a document would take below zero. */
export function shortfalls(needs: readonly StockNeed[]): Shortfall[] {
  return needs
    .map((n) => ({ ...n, afterMicros: n.onHandMicros - n.needMicros }))
    .filter((n) => n.needMicros > 0 && n.afterMicros < 0);
}

export type StockDecision =
  | { action: 'ok' }
  | { action: 'warn'; shortfalls: Shortfall[] }
  | { action: 'block'; shortfalls: Shortfall[] };

/** What to do about a document that takes stock out, under a policy. */
export function stockDecision(policy: StockPolicy, needs: readonly StockNeed[]): StockDecision {
  const short = shortfalls(needs);
  if (short.length === 0) return { action: 'ok' };
  return { action: policy === 'block' ? 'block' : 'warn', shortfalls: short };
}

/** Whether an item is at or below the level it should be reordered at. A level of zero means none is set. */
export const isLow = (onHandMicros: number, minMicros: number): boolean =>
  minMicros > 0 && onHandMicros < minMicros;

/* ------------------------------------------------------------------ count sheets */

export interface CountRow {
  /** Which column identified the item. */
  by: 'sku' | 'barcode' | 'name';
  key: string;
  countedMicros: number;
  line: number;
}

export interface CountSheet {
  rows: CountRow[];
  errors: { line: number; reason: 'no_item' | 'bad_quantity' | 'negative' | 'duplicate' }[];
}

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const ITEM_HEADS: Record<CountRow['by'], string[]> = {
  sku: ['sku', 'item code', 'code', 'item sku'],
  barcode: ['barcode', 'bar code', 'ean'],
  name: ['item', 'name', 'item name', 'product', 'description'],
};
const COUNT_HEADS = [
  'counted quantity',
  'counted qty',
  'counted',
  'physical quantity',
  'physical qty',
  'physical',
  'actual quantity',
  'actual',
  'count',
  'quantity',
  'qty',
];

/** The file a person fills in on the shop floor: what the system thinks, and a blank for what they counted. */
export function countSheetTemplate(
  items: readonly { sku: string; name: string; onHandMicros: number }[],
  quantityText: (micros: number) => string,
): string {
  const rows: CsvValue[][] = [
    ['SKU', 'Item', 'System quantity', 'Counted quantity'],
    ...items.map((i) => [i.sku, i.name, { numeric: quantityText(i.onHandMicros) }, '']),
  ];
  return toCsv(rows);
}

/**
 * Read a count sheet. The item is found by SKU, barcode or name (the first of those columns the file
 * has), the quantity is the "counted" column. Rows with a blank count are skipped (not counted),
 * rows that cannot be read are reported with their line, and an item listed twice is refused so one
 * count never silently overwrites another.
 */
export function parseCountSheet(text: string): CountSheet {
  const parsed = parseCsv(text);
  const [head, ...body] = parsed.rows;
  const out: CountSheet = { rows: [], errors: [] };
  if (!head) return out;
  const names = head.map(norm);
  const itemCol = (['sku', 'barcode', 'name'] as const)
    .map((by) => ({ by, at: names.findIndex((n) => ITEM_HEADS[by].includes(n)) }))
    .find((x) => x.at >= 0);
  let countAt = -1;
  for (const h of COUNT_HEADS) {
    countAt = names.indexOf(h);
    if (countAt >= 0) break;
  }
  if (!itemCol || countAt < 0) {
    out.errors.push({ line: parsed.lines[0] ?? 1, reason: !itemCol ? 'no_item' : 'bad_quantity' });
    return out;
  }
  const seen = new Set<string>();
  body.forEach((cells, i) => {
    const line = parsed.lines[i + 1] ?? i + 2;
    const key = (cells[itemCol.at] ?? '').trim();
    const raw = (cells[countAt] ?? '').trim();
    if (raw === '') return;
    if (key === '') {
      out.errors.push({ line, reason: 'no_item' });
      return;
    }
    const qty = parseQtyMicros(raw, { allowNegative: true });
    if (qty === null || qty === undefined) {
      out.errors.push({ line, reason: 'bad_quantity' });
      return;
    }
    if (qty < 0) {
      out.errors.push({ line, reason: 'negative' });
      return;
    }
    const id = key.toLowerCase();
    if (seen.has(id)) {
      out.errors.push({ line, reason: 'duplicate' });
      return;
    }
    seen.add(id);
    out.rows.push({ by: itemCol.by, key, countedMicros: qty, line });
  });
  return out;
}

/** What to add (positive) or remove (negative) to bring stock to what was counted. */
export const adjustmentToCount = (onHandMicros: number, countedMicros: number): number =>
  countedMicros - onHandMicros;
