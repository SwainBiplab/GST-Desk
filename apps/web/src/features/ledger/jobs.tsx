/**
 * Background work for the ledger (prompt 50): recurring journals due up to today are posted once per day per
 * business when the app opens. Nothing else here changes the books.
 */
import { RecurringJournalRepo } from '@gst/db';
import { today } from '@gst/domain';
import { useEffect } from 'react';

import { useAppDb } from '@/app/db';

const KEY = (businessId: string) => `ledger.recurring.ran.${businessId}`;

export function LedgerJobs() {
  const { database, ctx, status } = useAppDb();
  useEffect(() => {
    if (status !== 'ready' || !database || !ctx) return;
    const day = today(() => new Date());
    let last: string | null = null;
    try {
      last = localStorage.getItem(KEY(ctx.businessId));
    } catch {
      last = null;
    }
    if (last === day) return;
    void new RecurringJournalRepo(database)
      .postDue(ctx, day)
      .then(() => {
        try {
          localStorage.setItem(KEY(ctx.businessId), day);
        } catch {
          /* no storage: it runs again next open, which is harmless (one voucher per date) */
        }
      })
      .catch(() => undefined);
  }, [status, database, ctx]);
  return null;
}
