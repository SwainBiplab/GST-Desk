/**
 * Demo mode only (`?demo=1`): hooks on `window.__gstSync` that put the open book into the states a synced
 * book goes through, so the pill, the sheet and the conflict card can be seen and tested without a server.
 * Never mounted outside demo mode.
 */
import { syncConflictItem, type SyncConflictItem } from '@gst/ai';
import { createReviewItem } from '@gst/ai/db';
import { DocumentFlowRepo, NumberingRepo, announce } from '@gst/db';
import { useEffect } from 'react';

import { setSyncStatus, type SyncStatus } from './status';

import { DEMO_REQUESTED, useAppDb } from '@/app/db';

declare global {
  interface Window {
    __gstSync?: {
      setStatus(s: Partial<SyncStatus>): void;
      setMode(mode: 'local' | 'synced'): Promise<void>;
      raiseConflict(): Promise<string>;
    };
  }
}

export function SyncDevHooks() {
  const { database, ctx } = useAppDb();
  useEffect(() => {
    if (!DEMO_REQUESTED || !database || !ctx) return;
    window.__gstSync = {
      setStatus: (s) => setSyncStatus(s),
      setMode: async (mode) => {
        await new NumberingRepo(database).setMode(ctx, mode);
        announce(database, ['settings']);
      },
      raiseConflict: async () => {
        const drafts = await new DocumentFlowRepo(database).listDrafts(ctx, 1);
        const d = drafts[0];
        if (!d) throw new Error('no draft in the demo book');
        const item: SyncConflictItem = {
          table: 'documents',
          rowId: String(d['id']),
          label: String(d['party_name'] ?? 'Draft'),
          reason: 'the document was changed on another device',
          mine: {
            notes: 'Deliver before Friday (from the other counter)',
            version: Number(d['version']) + 1,
          },
          theirs: { notes: d['notes'] ?? null, version: d['version'] },
          ops: [
            {
              op: 'PATCH',
              table: 'documents',
              id: String(d['id']),
              data: { notes: 'Deliver before Friday (from the other counter)' },
            },
          ],
          deviceId: 'demo-other-counter',
          byUser: 'demo',
        };
        const row = await createReviewItem({
          db: database,
          ctx,
          kind: 'sync_conflict',
          payload: { table: 'documents', rowId: d['id'] },
          suggestion: item,
          schema: syncConflictItem,
          source: 'sync',
          dedupeKey: `sync_conflict:demo:${Date.now()}`,
        });
        announce(database, ['review_items']);
        return String(row['id']);
      },
    };
    return () => {
      delete window.__gstSync;
    };
  }, [database, ctx]);
  return null;
}
