import { PaymentFlowRepo, type DocPosition } from '@gst/db';
import { today } from '@gst/domain';
import { useMemo } from 'react';

import { useLiveQuery } from '@/app/db';

/** What each document owes and its derived payment status, by document id (one party, or all). */
export function usePositions(partyId?: string): Map<string, DocPosition> {
  const q = useLiveQuery<DocPosition[]>({
    tables: ['documents', 'payments', 'payment_allocations'],
    key: ['positions', partyId ?? 'all'],
    fn: async (d, c) =>
      (
        await new PaymentFlowRepo(d).positions(
          c,
          today(() => new Date()),
          partyId,
        )
      ).documents,
  });
  return useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p])), [q.data]);
}
