import { onChange } from '@gst/db';
import { useEffect } from 'react';

import { runChecks, type CheckInputs } from './hooks';

import { useAppDb } from '@/app/db';
import { useFeatureFlags } from '@/features/business/hooks';
import { readStatus } from '@/features/data/backup-service';

const SIX_HOURS = 6 * 3_600_000;
const TICK = 30 * 60_000;
const SAVE_DEBOUNCE = 3000;

const lastRunKey = (businessId: string) => `gst.inbox.lastRun.${businessId}`;

function lastRun(businessId: string): number {
  try {
    return Number(localStorage.getItem(lastRunKey(businessId)) ?? 0);
  } catch {
    return 0;
  }
}
function markRun(businessId: string) {
  try {
    localStorage.setItem(lastRunKey(businessId), String(Date.now()));
  } catch {
    /* storage may be blocked */
  }
}

/** What a run needs from outside the database: whether stock is tracked, and the device's last backup. */
export function checkInputs(inventoryEnabled: boolean): CheckInputs {
  const b = readStatus();
  return {
    inventoryEnabled,
    backup: { failedAt: b.failedAt, message: b.error, ok: b.ok },
  };
}

/**
 * The lightweight job runner for the review inbox. All rules run when the app opens and every six hours
 * while it stays open; the duplicate and HSN rules also run a moment after a party or item is saved.
 * Nothing it finds is applied: it only adds cards to the inbox (unless an auto-rule is on).
 */
export function InboxJobs() {
  const { database, ctx } = useAppDb();
  const flags = useFeatureFlags();
  const inventory = !!flags.inventory;
  const businessId = ctx?.businessId ?? null;

  useEffect(() => {
    if (!database || !ctx || !businessId) return;
    let stopped = false;
    const all = async () => {
      if (stopped) return;
      try {
        await runChecks(database, ctx, checkInputs(inventory));
        markRun(businessId);
      } catch (e) {
        console.warn('inbox checks failed', e);
      }
    };
    const maybe = () => {
      if (Date.now() - lastRun(businessId) >= SIX_HOURS) void all();
    };
    const first = setTimeout(() => void all(), 6000);
    const every = setInterval(maybe, TICK);

    let save: ReturnType<typeof setTimeout> | undefined;
    const off = onChange(database, (tables) => {
      if (!tables.has('parties') && !tables.has('items')) return;
      clearTimeout(save);
      save = setTimeout(() => {
        if (stopped) return;
        void runChecks(database, ctx, checkInputs(inventory), [
          'duplicate_party',
          'duplicate_item',
          'hsn_suggestion',
        ]).catch((e) => console.warn('inbox checks failed', e));
      }, SAVE_DEBOUNCE);
    });
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      clearTimeout(save);
      off();
    };
  }, [database, ctx, businessId, inventory]);
  return null;
}
