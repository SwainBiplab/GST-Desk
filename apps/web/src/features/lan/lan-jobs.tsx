import { useEffect, useRef } from 'react';

import { isDesktop } from '../desktop/bridge';

import { LAN_ON_KEY, lanStatus, readLanPort, startLan } from './service';

import { useAppDb } from '@/app/db';
import { useFeatureFlags } from '@/features/business/hooks';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** Brings tablet access back after a restart, when the person had left it on. Renders nothing. */
export function LanJobs() {
  const { database, ctx } = useAppDb();
  const flags = useFeatureFlags();
  const inventory = useRef(flags.inventory);
  useEffect(() => {
    inventory.current = flags.inventory;
  });
  useEffect(() => {
    if (!isDesktop() || !database || !ctx) return;
    if (read(LAN_ON_KEY) !== '1' || lanStatus().running) return;
    void startLan(database, ctx, {
      port: readLanPort(read),
      inventoryEnabled: () => inventory.current,
    });
    // started once per opened business; the tab handles later changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database, ctx?.businessId]);
  return null;
}
