import { getCounts, getTodaySummary, type Counts, type TodaySummary } from '@gst/db';
import { today } from '@gst/domain';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useLiveQuery } from './db';
import { isPageId, type PageId } from './nav';
import type { Shell } from './store';

/** Navigate by path string. Routes are typed, so the cast is confined to this one helper. */
export function useAppNavigate() {
  const router = useRouter();
  return useCallback(
    (to: string, search?: Record<string, unknown>) => {
      void router.navigate({ to: to as never, ...(search ? { search: search as never } : {}) });
    },
    [router],
  );
}

/** Which shell and page the URL is on. */
export function useLocationInfo(): {
  shell: Shell | null;
  page: PageId | null;
  pathname: string;
  search: Record<string, unknown>;
} {
  const loc = useRouterState({ select: (s) => s.location });
  const [, first, second] = loc.pathname.split('/');
  const shell = first === 'shop' || first === 'books' ? first : null;
  const page = second && isPageId(second) ? second : null;
  return { shell, page, pathname: loc.pathname, search: loc.search as Record<string, unknown> };
}

const COUNT_TABLES = ['parties', 'items', 'documents', 'payments', 'review_items'];

export function useCounts(): Counts | undefined {
  return useLiveQuery<Counts>({
    tables: COUNT_TABLES,
    key: ['counts'],
    fn: (d, c) => getCounts(d, c),
  }).data;
}

export function useTodaySummary(): TodaySummary | undefined {
  const iso = today(() => new Date());
  return useLiveQuery<TodaySummary>({
    tables: ['documents', 'payments', 'payment_allocations'],
    key: ['today', iso],
    fn: (d, c) => getTodaySummary(d, c, iso),
  }).data;
}
