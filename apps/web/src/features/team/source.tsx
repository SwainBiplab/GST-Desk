/**
 * Feeds the permission store from where the open book lives (prompt 42): a synced book with a cloud
 * session reads the member's permissions from the API every 30 seconds; a local book is its owner's.
 * Demo mode may set a role by hand (`window.__gstSync.setRole`) and that stays until the book changes.
 */
import { NumberingRepo } from '@gst/db';
import { useEffect } from 'react';

import { getPermissions, resetPermissions, watchCloudPermissions } from './permissions';

import { useAppDb, useLiveQuery } from '@/app/db';
import { CloudClient, readSession } from '@/features/cloud/client';

export const browserStore = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

export function PermissionsSource() {
  const { ctx } = useAppDb();
  const mode = useLiveQuery<'local' | 'synced'>({
    tables: ['settings'],
    key: ['book-mode'],
    fn: (d, c) => new NumberingRepo(d).getMode(c),
  });
  const synced = mode.data === 'synced';
  const orgId = ctx?.orgId ?? '';

  useEffect(() => {
    const session = readSession(browserStore.get);
    if (!synced || !session || !orgId) {
      if (getPermissions().source !== 'demo') resetPermissions();
      return;
    }
    const client = new CloudClient(session.baseUrl, session.token);
    return watchCloudPermissions({
      orgId,
      fetchPermissions: () => client.permissions(orgId),
      storage: browserStore,
    });
  }, [synced, orgId]);
  return null;
}
