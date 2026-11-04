import {
  REPORTS,
  SettingsRepo,
  exportReport,
  getDashboard,
  runReport,
  type Dashboard,
  type ReportResult,
  type ReportRow,
} from '@gst/db';
import { today } from '@gst/domain';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toParams, type ReportState } from './model';

import { useAppDb, useLiveQuery } from '@/app/db';

/** Rows fetched at a time by a register; the next page loads as the table is scrolled. */
export const PAGE_ROWS = 200;

/** Every table a report reads, so it refreshes when any of them is written. */
export const REPORT_TABLES = [
  'documents',
  'document_lines',
  'payments',
  'payment_allocations',
  'parties',
  'items',
  'units',
  'number_series',
  'stock_movements',
  'ledger_entries',
];

export const todayIso = (): string => today(() => new Date());

export interface ReportData {
  rows: ReportRow[];
  /** Rows in the whole filtered set. */
  count: number;
  totals: Record<string, number>;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  /** Load every remaining page (up to `cap` rows) and return them. */
  loadAll: (cap: number) => Promise<ReportRow[]>;
  error: Error | null;
  ms: number | null;
}

/** One report, page by page, refreshed when the data under it changes. */
export function useReportData(state: ReportState | null): ReportData {
  const { database, ctx } = useAppDb();
  const day = todayIso();
  const q = useInfiniteQuery({
    queryKey: [...REPORT_TABLES, ctx?.businessId ?? null, 'report', state, day],
    enabled: !!database && !!ctx && !!state,
    meta: { tables: REPORT_TABLES },
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const def = REPORTS[state!.id];
      const started = performance.now();
      const r = await runReport(
        database!,
        ctx!,
        state!.id,
        toParams(state!, day),
        def.paged ? { offset: pageParam, limit: PAGE_ROWS } : undefined,
      );
      return { ...r, ms: Math.round(performance.now() - started) } as ReportResult & { ms: number };
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return REPORTS[last.id].paged && loaded < last.count ? loaded : undefined;
    },
  });
  const pages = q.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = q;
  const loadAll = useCallback(
    async (cap: number): Promise<ReportRow[]> => {
      let more = hasNextPage;
      let latest = q.data?.pages ?? [];
      while (more && latest.reduce((n, p) => n + p.rows.length, 0) < cap) {
        const res = await fetchNextPage();
        latest = res.data?.pages ?? latest;
        more = res.hasNextPage;
      }
      return latest.flatMap((p) => p.rows);
    },
    [fetchNextPage, hasNextPage, q.data],
  );
  return {
    rows,
    count: pages[0]?.count ?? 0,
    totals: pages[0]?.totals ?? {},
    isLoading: q.isLoading,
    isFetchingMore: isFetchingNextPage,
    hasMore: !!hasNextPage,
    fetchMore: () => void fetchNextPage(),
    loadAll,
    error: q.error,
    ms: pages[0] ? pages[0].ms : null,
  };
}

/** Read every row of a report straight from the database, for export. */
export function useReportExport() {
  const { database, ctx } = useAppDb();
  return useCallback(
    async (state: ReportState) => {
      const rows: ReportRow[] = [];
      let totals: Record<string, number> = {};
      await exportReport(database!, ctx!, state.id, toParams(state, todayIso()), (batch, t) => {
        rows.push(...batch);
        totals = t;
      });
      return { rows, totals };
    },
    [database, ctx],
  );
}

/* ------------------------------------------------------------------ saved views */

export interface SavedView {
  id: string;
  name: string;
  /** The address search of the report when it was saved (period, filters, columns, grouping). */
  search: Record<string, string>;
}

const VIEWS_KEY = 'reports.views';

/** Named report setups, kept with the business so a CA and the owner see the same ones. */
export function useSavedViews() {
  const { database, ctx } = useAppDb();
  const q = useLiveQuery<SavedView[]>({
    tables: ['settings'],
    key: ['report-views'],
    fn: async (d, c) => (await new SettingsRepo(d).getValue<SavedView[]>(c, VIEWS_KEY)) ?? [],
  });
  const views = q.data ?? [];
  const write = useCallback(
    async (next: SavedView[]) => {
      await new SettingsRepo(database!).set(ctx!, VIEWS_KEY, next);
    },
    [database, ctx],
  );
  return {
    views,
    save: async (name: string, search: Record<string, string>) => {
      const id = `v${Date.now().toString(36)}`;
      await write([...views, { id, name: name.trim(), search }]);
      return id;
    },
    remove: (id: string) => write(views.filter((v) => v.id !== id)),
  };
}

/* ------------------------------------------------------------------ dashboard */

export function useDashboard(): Dashboard | undefined {
  const day = todayIso();
  return useLiveQuery<Dashboard>({
    tables: [...REPORT_TABLES, 'review_items', 'items'],
    key: ['dashboard', day],
    fn: (d, c) => getDashboard(d, c, day),
  }).data;
}
