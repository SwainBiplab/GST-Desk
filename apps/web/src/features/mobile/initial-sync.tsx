/** The first download of a cloud business on this phone (prompt 43): a bar, a count, and the way out. */
import { Button } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useOnline } from './layout';

import { useAppNavigate } from '@/app/hooks';
import { useSyncStatus } from '@/features/sync/status';

export function InitialSync() {
  const { t } = useTranslation();
  const s = useSyncStatus();
  const online = useOnline();
  const navigate = useAppNavigate();
  const pct = s.progress ? Math.round(s.progress.fraction * 100) : null;
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="initial-sync"
    >
      <h1 className="text-lg font-semibold">{t('mobile.account.syncing')}</h1>
      <div
        className="h-2 w-full max-w-xs overflow-hidden rounded bg-surface-2"
        role="progressbar"
        aria-valuenow={pct ?? 0}
      >
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${pct ?? (s.connected ? 5 : 0)}%` }}
        />
      </div>
      <p className="text-sm text-fg-muted" data-testid="initial-sync-progress">
        {s.progress
          ? t('mobile.account.progress', { done: s.progress.done, total: s.progress.total })
          : online
            ? t('mobile.account.connecting')
            : t('mobile.account.offline')}
      </p>
      {s.errors[0] && <p className="text-sm text-danger">{s.errors[0].message}</p>}
      <Button variant="ghost" onClick={() => navigate('/shop/settings', { screen: 'account' })}>
        {t('mobile.account.title')}
      </Button>
    </div>
  );
}
