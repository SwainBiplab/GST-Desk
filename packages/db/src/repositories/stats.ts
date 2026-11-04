import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';

import { runInTx, type Ctx } from './base';

export interface Counts {
  parties: number;
  items: number;
  documents: number;
  payments: number;
  reviewPending: number;
}

const n = (v: unknown) => Number(v ?? 0);

/** Row counts for navigation badges (soft-deleted rows excluded). */
export async function getCounts(d: Database, ctx: Ctx): Promise<Counts> {
  return runInTx(d, ctx, async (tx) => {
    const b = ctx.businessId;
    const one = async (table: string, extra = '') => {
      const rows = await queryRows(
        d,
        tx,
        sql`SELECT count(*) AS c FROM ${sql.identifier(table)} WHERE business_id = ${b} AND deleted_at IS NULL ${sql.raw(extra)}`,
      );
      return n(rows[0]?.['c']);
    };
    return {
      parties: await one('parties'),
      items: await one('items'),
      documents: await one('documents'),
      payments: await one('payments'),
      reviewPending: await one('review_items', "AND status = 'pending'"),
    };
  });
}

export interface TodaySummary {
  salesPaise: number;
  cashReceivedPaise: number;
  /** Issued sales not yet covered by payment allocations. */
  pendingPaise: number;
}

const SALES = "('tax_invoice','bill_of_supply','debit_note')";

/** Numbers for the Shop bottom strip. `today` is an ISO date from the caller's clock. */
export async function getTodaySummary(d: Database, ctx: Ctx, today: string): Promise<TodaySummary> {
  return runInTx(d, ctx, async (tx) => {
    const b = ctx.businessId;
    const sales = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(total_paise), 0) AS v FROM documents
          WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'issued'
            AND type IN ${sql.raw(SALES)} AND date = ${today}`,
    );
    const cash = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(amount_paise), 0) AS v FROM payments
          WHERE business_id = ${b} AND deleted_at IS NULL AND direction = 'received' AND mode = 'cash'
            AND status = 'cleared' AND date = ${today}`,
    );
    const billed = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(total_paise), 0) AS v FROM documents
          WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'issued'
            AND type IN ${sql.raw(SALES)}`,
    );
    const paid = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(a.amount_paise), 0) AS v
          FROM payment_allocations a
          JOIN documents dc ON dc.id = a.document_id
          WHERE a.business_id = ${b} AND a.deleted_at IS NULL AND a.kind = 'payment'
            AND dc.status = 'issued' AND dc.type IN ${sql.raw(SALES)}`,
    );
    return {
      salesPaise: n(sales[0]?.['v']),
      cashReceivedPaise: n(cash[0]?.['v']),
      pendingPaise: Math.max(0, n(billed[0]?.['v']) - n(paid[0]?.['v'])),
    };
  });
}

export interface RecentItem {
  kind: 'document' | 'party' | 'item';
  id: string;
  title: string;
  subtitle: string;
}

/** Most recently touched rows across aggregates, for the command bar's "recent" list. */
export async function getRecent(d: Database, ctx: Ctx, limit = 8): Promise<RecentItem[]> {
  return runInTx(d, ctx, async (tx) => {
    const b = ctx.businessId;
    const rows = await queryRows(
      d,
      tx,
      sql`SELECT kind, id, title, subtitle, updated_at FROM (
            SELECT 'document' AS kind, id, coalesce(number, 'Draft ' || type) AS title,
                   coalesce(party_name, '') AS subtitle, updated_at
              FROM documents WHERE business_id = ${b} AND deleted_at IS NULL
            UNION ALL
            SELECT 'party', id, name, coalesce(gstin, ''), updated_at
              FROM parties WHERE business_id = ${b} AND deleted_at IS NULL
            UNION ALL
            SELECT 'item', id, name, coalesce(sku, ''), updated_at
              FROM items WHERE business_id = ${b} AND deleted_at IS NULL
          ) t ORDER BY updated_at DESC LIMIT ${limit}`,
    );
    return rows.map((r) => ({
      kind: r['kind'] as RecentItem['kind'],
      id: String(r['id']),
      title: String(r['title']),
      subtitle: String(r['subtitle']),
    }));
  });
}

export interface OnboardingFacts {
  parties: number;
  items: number;
  /** Issued sales documents (tax invoices and bills of supply). */
  issuedSales: number;
  payments: number;
}

/** What the getting-started checklist needs from the data. */
export async function getOnboardingFacts(d: Database, ctx: Ctx): Promise<OnboardingFacts> {
  const c = await getCounts(d, ctx);
  const sales = await runInTx(d, ctx, async (tx) => {
    const rows = await queryRows(
      d,
      tx,
      sql`SELECT count(*) AS c FROM documents
          WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND status = 'issued'
            AND type IN ('tax_invoice', 'bill_of_supply')`,
    );
    return n(rows[0]?.['c']);
  });
  return { parties: c.parties, items: c.items, issuedSales: sales, payments: c.payments };
}
