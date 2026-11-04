/**
 * Database context for the app: opens SQLite lazily, exposes the current business context and a
 * `useLiveQuery` hook that refetches when repositories commit writes to the tables it reads.
 */
import { announce, listBusinesses, onChange, type Ctx, type Database, type Row } from '@gst/db';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { deviceId, useAppStore } from './store';

export type DbStatus = 'loading' | 'ready' | 'error';

export interface AppDbValue {
  status: DbStatus;
  database: Database | null;
  /** True when data survives a reload (OPFS or Tauri); false for the in-memory fallback. */
  persistent: boolean;
  kind: 'opfs' | 'memory' | 'tauri' | null;
  error: Error | null;
  businesses: Row[];
  business: Row | null;
  /** Repository context for the current business, or null until one exists. */
  ctx: Ctx | null;
  /** Create the deterministic demo business (50 parties, 200 items, 500 documents). */
  loadDemoData: () => Promise<void>;
}

const Context = createContext<AppDbValue | null>(null);

/** Read once at load: router redirects drop the query string. */
const DEMO_REQUESTED = new URLSearchParams(location.search).get('demo') === '1';

const TABLES_ALL = [
  'businesses',
  'parties',
  'items',
  'documents',
  'document_lines',
  'payments',
  'payment_allocations',
  'stock_movements',
  'review_items',
  'number_series',
  'units',
  'ledger_accounts',
  'godowns',
];

export function AppDbProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<
    Pick<AppDbValue, 'status' | 'database' | 'persistent' | 'kind' | 'error'>
  >({
    status: 'loading',
    database: null,
    persistent: false,
    kind: null,
    error: null,
  });
  const businessId = useAppStore((s) => s.businessId);
  const setBusinessId = useAppStore((s) => s.setBusinessId);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const { openAppDatabase } = await import('./db-impl');
        const opened = await openAppDatabase();
        setState({
          status: 'ready',
          database: opened.database,
          persistent: opened.persistent,
          kind: opened.kind,
          error: null,
        });
      } catch (e) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: e instanceof Error ? e : new Error(String(e)),
        }));
      }
    })();
  }, []);

  // refetch queries that read any table a repository just wrote
  const database = state.database;
  useEffect(() => {
    if (!database) return;
    return onChange(database, (tables) => {
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const read = q.meta?.['tables'] as string[] | undefined;
          return !!read && read.some((t) => tables.has(t));
        },
      });
    });
  }, [database, queryClient]);

  const businessesQuery = useQuery({
    queryKey: ['businesses'],
    enabled: !!database,
    meta: { tables: ['businesses'] },
    queryFn: () => listBusinesses(database!),
  });
  const businesses = useMemo(() => businessesQuery.data ?? [], [businessesQuery.data]);
  const business = useMemo(
    () => businesses.find((b) => b['id'] === businessId) ?? businesses[0] ?? null,
    [businesses, businessId],
  );

  useEffect(() => {
    if (business && business['id'] !== businessId) setBusinessId(business['id']);
  }, [business, businessId, setBusinessId]);

  const ctx = useMemo<Ctx | null>(
    () =>
      business
        ? {
            orgId: business['org_id'],
            businessId: business['id'],
            actor: 'local-user',
            deviceId: deviceId(),
          }
        : null,
    [business],
  );

  const loadDemoData = useCallback(async () => {
    if (!database) return;
    const { seedDemo } = await import('@gst/db/seed');
    const { ctx: seeded } = await seedDemo(database);
    announce(database, TABLES_ALL);
    setBusinessId(seeded.businessId);
  }, [database, setBusinessId]);

  // `?demo=1` seeds an empty database on first load (used by e2e and perf runs)
  useEffect(() => {
    if (state.status !== 'ready' || !businessesQuery.isSuccess || businesses.length > 0) return;
    if (DEMO_REQUESTED) void loadDemoData();
  }, [state.status, businessesQuery.isSuccess, businesses.length, loadDemoData]);

  const value = useMemo<AppDbValue>(
    () => ({ ...state, businesses, business, ctx, loadDemoData }),
    [state, businesses, business, ctx, loadDemoData],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppDb(): AppDbValue {
  const v = useContext(Context);
  if (!v) throw new Error('useAppDb must be used inside <AppDbProvider>');
  return v;
}

/**
 * Query the local database. `tables` lists what `fn` reads; the query refetches whenever a repository
 * commits a write to any of them. Keys are `[...tables, businessId, ...key]` so each aggregate has its own prefix.
 */
export function useLiveQuery<T>(opts: {
  tables: string[];
  key?: QueryKey;
  enabled?: boolean;
  fn: (database: Database, ctx: Ctx) => Promise<T>;
}) {
  const { database, ctx } = useAppDb();
  return useQuery({
    queryKey: [...opts.tables, ctx?.businessId ?? null, ...(opts.key ?? [])],
    enabled: !!database && !!ctx && (opts.enabled ?? true),
    meta: { tables: opts.tables },
    queryFn: () => opts.fn(database!, ctx!),
  });
}
