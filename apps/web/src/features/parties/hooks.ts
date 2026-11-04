import {
  BaseRepo,
  DocumentRepo,
  PartyRepo,
  getPartyAccount,
  getPartyAccounts,
  type PartyAccount,
  type PartyAccountDetail,
  type Row,
} from '@gst/db';
import { today } from '@gst/domain';
import { desc, eq } from 'drizzle-orm';
import { useMemo } from 'react';

import { useAppDb, useLiveQuery } from '@/app/db';
import { aiRouterFor } from '@/lib/ai';

const MONEY_TABLES = ['parties', 'documents', 'payments', 'payment_allocations'];

/** Every live party plus its balance, overdue and ageing. Refetches when money moves. */
export function usePartyList() {
  const iso = today(() => new Date());
  return useLiveQuery<{ parties: Row[]; accounts: Map<string, PartyAccount> }>({
    tables: MONEY_TABLES,
    key: ['list', iso],
    fn: async (d, c) => {
      const [parties, accounts] = await Promise.all([
        new PartyRepo(d).list(c, { orderBy: d.schema.parties.name }),
        getPartyAccounts(d, c, iso),
      ]);
      return { parties, accounts };
    },
  });
}

/** Ids matching a search, ranked. Disabled for an empty query. */
export function usePartySearch(q: string) {
  const query = q.trim();
  return useLiveQuery<string[]>({
    tables: ['parties'],
    key: ['search', query],
    enabled: query.length > 0,
    fn: async (d, c) =>
      (await new PartyRepo(d).search(c, query, 500)).map((p) => p['id'] as string),
  });
}

export function useParty(id: string | null) {
  return useLiveQuery<Row | null>({
    tables: ['parties'],
    key: ['one', id],
    enabled: !!id,
    fn: (d, c) => new PartyRepo(d).get(c, id!),
  });
}

export function usePartyAccount(id: string | null) {
  const iso = today(() => new Date());
  return useLiveQuery<PartyAccountDetail>({
    tables: MONEY_TABLES,
    key: ['account', id, iso],
    enabled: !!id,
    fn: (d, c) => getPartyAccount(d, c, id!, iso),
  });
}

export function usePartyDocuments(id: string | null) {
  return useLiveQuery<Row[]>({
    tables: ['documents'],
    key: ['documents', id],
    enabled: !!id,
    fn: (d, c) => new DocumentRepo(d).listBy(c, { partyId: id! }),
  });
}

export function usePartyPayments(id: string | null) {
  return useLiveQuery<Row[]>({
    tables: ['payments'],
    key: ['payments', id],
    enabled: !!id,
    fn: (d, c) =>
      new BaseRepo(d, 'payments').list(c, {
        where: eq(d.schema.payments.party_id, id!),
        orderBy: desc(d.schema.payments.date),
      }),
  });
}

/** The business's default UPI id, for "copy UPI link". */
export function useDefaultUpi(): string | null {
  const { data } = useLiveQuery<string | null>({
    tables: ['business_accounts'],
    key: ['upi'],
    fn: async (d, c) => {
      const rows = await new BaseRepo(d, 'business_accounts').list(c);
      const upi = rows.filter((r) => r['upi_id']);
      return (upi.find((r) => r['is_default']) ?? upi[0])?.['upi_id'] ?? null;
    },
  });
  return data ?? null;
}

/** Router whose Tier 0 rules can read this business's parties (for duplicate detection). */
export function usePartyRouter() {
  const { database, ctx } = useAppDb();
  return useMemo(() => {
    if (!database || !ctx) return null;
    return aiRouterFor({ parties: () => new PartyRepo(database).listLite(ctx) });
  }, [database, ctx]);
}
