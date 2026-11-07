/**
 * Pull down from the top of a list to refresh (prompt 43): on a synced book that is a sync now; on a
 * local book the live queries are read again. The pull resists after the trigger (`logic.ts`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { pullOffset, pullTriggers } from './logic';

import { canSyncNow, runSyncNow } from '@/features/sync/status';

export function PullToRefresh({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ y: number; id: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setBusy(true);
    try {
      if (canSyncNow()) await runSyncNow();
      await queryClient.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((box.current?.scrollTop ?? 1) > 0 || e.pointerType === 'mouse') return;
    start.current = { y: e.clientY, id: e.pointerId };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    const d = e.clientY - start.current.y;
    if (d > 8) setDy(d);
  };
  const onUp = () => {
    if (!start.current) return;
    start.current = null;
    if (pullTriggers(dy)) void refresh();
    setDy(0);
  };

  const offset = pullOffset(dy);
  return (
    <div
      ref={box}
      className="relative min-h-0 flex-1 overflow-auto overscroll-y-contain"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      data-testid="pull-to-refresh"
      data-busy={busy}
    >
      {(offset > 0 || busy) && (
        <div
          className="flex items-center justify-center text-xs text-fg-muted"
          style={{ height: busy ? 32 : offset }}
          aria-live="polite"
        >
          {busy
            ? t('mobile.refreshing')
            : pullTriggers(dy)
              ? t('mobile.release')
              : t('mobile.pull')}
        </div>
      )}
      {children}
    </div>
  );
}
