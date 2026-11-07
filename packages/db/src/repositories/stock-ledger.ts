/**
 * Where stock meets the books (prompt 51, FR-112). The business picks a valuation method once; from then
 * on every movement is costed by `runValuation` over the item's history and posted: goods in debit
 * Inventory, goods out credit it for what they cost. Documents post with their own entries (reversed
 * with the document); adjustments and opening stock post a journal voucher. Nothing here is called
 * until a method is set, so a business that never chooses one keeps its stock valued at purchase price.
 */
import {
  postStock,
  runValuation,
  type LedgerLine,
  type StockAgainst,
  type StockEvent,
  type ValuationMethod,
  type ValuationResult,
  isValuationMethod,
} from '@gst/domain';
import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { SettingsRepo } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { accountIdByKeyIn } from './chart';

export const VALUATION_KEY = 'inventory.valuation';

export interface ValuationSetting {
  method: ValuationMethod;
  /** When the method was chosen or last migrated. */
  since: string;
}

export async function valuationIn(
  d: Database,
  tx: any,
  ctx: Ctx,
): Promise<ValuationSetting | null> {
  const v = await new SettingsRepo(d).getValue<Partial<ValuationSetting>>(
    { ...ctx, tx },
    VALUATION_KEY,
  );
  return v && isValuationMethod(v.method)
    ? { method: v.method, since: String(v.since ?? '') }
    : null;
}

const n = (v: unknown): number => Number(v ?? 0);
const big = (v: unknown): bigint => BigInt(Math.round(Number(v ?? 0)));

/** Document types whose stock-in movements were written at cost (the line's rate). */
const COSTED_IN = new Set(['purchase_bill']);

/**
 * One item's movements as the engine wants them, in date order (then the order they were written).
 * Transfers are left out: the stock is the business's whichever godown holds it. A movement that
 * carries its cost says so; an older purchase or opening is costed at its rate; a sales return and a
 * sale are left to the engine unless the cost is fixed (a reversal).
 */
export async function stockEventsIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  itemId: string,
  upTo?: string,
): Promise<StockEvent[]> {
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT m.id, m.date, m.kind, m.qty_micros, m.rate_paise, m.cost_paise, m.cost_fixed,
               m.document_id, dc.type AS doc_type
        FROM stock_movements m LEFT JOIN documents dc ON dc.id = m.document_id
        WHERE m.business_id = ${ctx.businessId} AND m.deleted_at IS NULL AND m.item_id = ${itemId}
          AND m.kind <> 'transfer' ${upTo ? sql`AND m.date <= ${upTo}` : sql``}
        ORDER BY m.date, m.created_at, m.id`,
  );
  return rows.map((r) => {
    const qty = n(r['qty_micros']);
    const fixed = !!r['cost_fixed'] || Number(r['cost_fixed']) === 1;
    let cost: bigint | null = null;
    if (r['cost_paise'] != null && (qty >= 0 || fixed)) cost = big(r['cost_paise']);
    else if (qty > 0 && !r['document_id']) cost = (big(r['rate_paise']) * BigInt(qty)) / 1_000_000n;
    else if (qty > 0 && COSTED_IN.has(String(r['doc_type'])))
      cost = (big(r['rate_paise']) * BigInt(qty)) / 1_000_000n;
    return { id: String(r['id']), date: String(r['date']), qtyMicros: qty, costPaise: cost };
  });
}

/** The item's purchase price: what an out is costed at when nothing has ever come in. */
async function fallbackRateIn(d: Database, tx: any, ctx: Ctx, itemId: string): Promise<bigint> {
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT purchase_rate_paise AS r FROM items WHERE id = ${itemId} AND business_id = ${ctx.businessId}`,
  );
  return big(rows[0]?.['r']);
}

/** Run the method over one item, as at a date (every movement when none is given). */
export async function valueItemIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  itemId: string,
  method: ValuationMethod,
  upTo?: string,
): Promise<ValuationResult> {
  const events = await stockEventsIn(d, tx, ctx, itemId, upTo);
  return runValuation(method, events, await fallbackRateIn(d, tx, ctx, itemId));
}

/** Ledger entries for a document's stock, written beside its sales or purchase entries. */
export async function postDocumentStockIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  doc: Row,
  lines: readonly LedgerLine[],
): Promise<void> {
  const entries = new BaseRepo(d, 'ledger_entries');
  for (const e of lines)
    await (entries as any).createIn(tx, ctx, {
      document_id: doc['id'],
      party_id: null,
      account_id: await accountIdByKeyIn(d, tx, ctx, e.account),
      debit_paise: Number(e.debitPaise),
      credit_paise: Number(e.creditPaise),
      date: doc['date'],
      narration: e.narration,
    });
}

/** The posting lines for one direction and cost, against the account the movement's cause names. */
export const stockLines = (
  direction: 'in' | 'out',
  costPaise: bigint,
  against: StockAgainst,
  narration: string,
): LedgerLine[] => postStock({ direction, costPaise, against, narration });

/**
 * A journal voucher for stock that moved without a document (an adjustment, opening stock, a
 * valuation true-up). Returns the voucher id, or null when there was nothing to post.
 */
export async function postStockVoucherIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  input: {
    date: string;
    narration: string;
    lines: readonly LedgerLine[];
    kind?: 'journal' | 'reclass';
  },
): Promise<string | null> {
  const lines = input.lines.filter((l) => l.debitPaise !== 0n || l.creditPaise !== 0n);
  if (lines.length === 0) return null;
  // the ledger module reads this one at call time only, so the import is late to keep the modules acyclic
  const { JournalRepo } = await import('./ledger');
  const voucher = await new JournalRepo(d).post(
    { ...ctx, tx },
    {
      date: input.date,
      kind: input.kind ?? 'journal',
      narration: input.narration,
      lines: await Promise.all(
        lines.map(async (l) => ({
          accountId: await accountIdByKeyIn(d, tx, ctx, l.account),
          debitPaise: l.debitPaise,
          creditPaise: l.creditPaise,
          narration: l.narration,
        })),
      ),
    },
  );
  return voucher.id;
}

/** Sum the debit less credit of the Inventory ledger up to a date (everything when none). */
export async function inventoryLedgerBalanceIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  upTo?: string,
): Promise<bigint> {
  const accountId = await accountIdByKeyIn(d, tx, ctx, 'inventory');
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT coalesce(sum(debit_paise), 0) AS dr, coalesce(sum(credit_paise), 0) AS cr
        FROM ledger_entries
        WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND account_id = ${accountId}
          ${upTo ? sql`AND date <= ${upTo}` : sql``}`,
  );
  return big(rows[0]?.['dr']) - big(rows[0]?.['cr']);
}
