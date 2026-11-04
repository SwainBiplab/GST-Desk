import {
  ItemRepo,
  UnitRepo,
  listHsnVersions,
  lookupHsn,
  type HsnLookupResult,
  type HsnVersionRow,
  type RateChangeRow,
  type Row,
} from '@gst/db';
import { today } from '@gst/domain';
import { useEffect, useMemo, useState } from 'react';

import { useAppDb, useLiveQuery } from '@/app/db';
import { hsnRouterFor, suggestHsn } from '@/lib/ai';

/** Every live item by name. Refetches when items change. */
export function useItemList() {
  return useLiveQuery<Row[]>({
    tables: ['items'],
    key: ['list'],
    fn: (d, c) => new ItemRepo(d).list(c, { orderBy: d.schema.items.name }),
  });
}

/** Ids matching a search, ranked. Disabled for an empty query. */
export function useItemSearch(q: string) {
  const query = q.trim();
  return useLiveQuery<string[]>({
    tables: ['items'],
    key: ['search', query],
    enabled: query.length > 0,
    fn: async (d, c) => (await new ItemRepo(d).search(c, query, 500)).map((r) => r['id'] as string),
  });
}

export function useItem(id: string | null) {
  return useLiveQuery<Row | null>({
    tables: ['items'],
    key: ['one', id],
    enabled: !!id,
    fn: (d, c) => new ItemRepo(d).get(c, id!),
  });
}

export function useUnits() {
  return useLiveQuery<Row[]>({
    tables: ['units'],
    key: ['list'],
    fn: (d, c) => new UnitRepo(d).list(c, { orderBy: d.schema.units.code }),
  });
}

/** Items whose GST rate no longer matches the HSN master. */
export function useRateChanges() {
  const iso = today(() => new Date());
  return useLiveQuery<RateChangeRow[]>({
    tables: ['items', 'hsn_master'],
    key: ['rate-changes', iso],
    fn: (d, c) => new ItemRepo(d).rateChanges(c, iso),
  });
}

export function useHsnVersions() {
  const { database } = useAppDb();
  return useLiveQuery<HsnVersionRow[]>({
    tables: ['rate_master_versions'],
    key: ['versions', !!database],
    fn: (d) => listHsnVersions(d),
  });
}

/** The master entry for a typed code today, so the form can show its description and rate. */
export function useHsnEntry(code: string) {
  const clean = code.replace(/\s+/g, '');
  return useLiveQuery<HsnLookupResult | null>({
    tables: ['hsn_master'],
    key: ['entry', clean],
    enabled: /^\d{4,8}$/.test(clean),
    fn: (d) => lookupHsn(d, clean),
  });
}

export interface HsnHit {
  code: string;
  description: string;
  rateBp: number;
  cessBp: number;
}

/** Top matches from the offline rules provider for a free-text description. Debounced. */
export function useHsnSuggestions(text: string, enabled: boolean) {
  const { database } = useAppDb();
  const router = useMemo(() => (database ? hsnRouterFor(database) : null), [database]);
  const query = text.trim();
  const versionKey = useHsnVersionKey();
  const key = `${query}|${versionKey}`;
  const active = enabled && !!router && query.length >= 3;
  const [result, setResult] = useState<{ key: string; hits: HsnHit[] }>({ key: '', hits: [] });

  useEffect(() => {
    if (!active || !router) return;
    let live = true;
    const timer = setTimeout(() => {
      void suggestHsn(router, query, 3).then((hits) => {
        if (live) setResult({ key, hits });
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, router, query, key]);

  const fresh = active && result.key === key;
  return { hits: fresh ? result.hits : [], loading: active && !fresh };
}

/** Changes when the master is (re)loaded, so suggestions refresh after the first import. */
function useHsnVersionKey(): number {
  const { data } = useHsnVersions();
  return data?.length ?? 0;
}
