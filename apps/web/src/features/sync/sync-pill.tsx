/**
 * The pill in the header and its sheet: where the book lives (local only, or synced), what is waiting to
 * upload, conflicts to settle, the last good sync, recent errors and "Sync now".
 */
import { NumberingRepo, ReviewRepo } from '@gst/db';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { canSyncNow, pillState, runSyncNow, useSyncStatus } from './status';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { dyn } from '@/lib/dyn-key';

/** The business's mode and how many conflicts wait in its inbox. */
function useSyncFacts() {
  return useLiveQuery<{ mode: 'local' | 'synced'; conflicts: number }>({
    tables: ['settings', 'review_items'],
    key: ['sync-facts'],
    fn: async (d, c) => {
      const mode = await new NumberingRepo(d).getMode(c);
      const open = await new ReviewRepo(d).inbox(c, {
        view: 'open',
        now: Date.now(),
        kinds: ['sync_conflict'],
      });
      return { mode, conflicts: open.length };
    },
  });
}

export function SyncPill() {
  const { t } = useTranslation();
  const { status: dbStatus, persistent } = useAppDb();
  const facts = useSyncFacts();
  const s = useSyncStatus();
  const shell = useAppStore((x) => x.shell);
  const navigate = useAppNavigate();
  const mode = facts.data?.mode ?? 'local';
  const pill = pillState(mode, s, facts.data?.conflicts ?? 0);
  const unsaved = dbStatus === 'ready' && !persistent;

  if (mode === 'local') {
    return (
      <Badge
        tone={unsaved ? 'warning' : 'neutral'}
        data-testid="sync-pill"
        data-state="local"
        data-db-status={dbStatus}
        title={unsaved ? t('chrome.notSavedTitle') : t('chrome.syncLocalTitle')}
      >
        {unsaved ? t('chrome.localNotSaved') : t('chrome.local')}
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-sm"
          data-testid="sync-pill"
          data-state={pill.kind}
          aria-label={t('sync.sheet.title')}
        >
          <Badge tone={pill.tone}>
            {t(dyn(`sync.pill.${pill.kind}`), pill.count ? { count: pill.count } : {})}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" data-testid="sync-sheet">
        <h2 className="font-medium">{t('sync.sheet.title')}</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 py-2 text-sm">
          <dt className="text-fg-muted">{t('sync.sheet.state')}</dt>
          <dd data-testid="sync-sheet-state">
            {t(dyn(`sync.pill.${pill.kind}`), pill.count ? { count: pill.count } : {})}
          </dd>
          <dt className="text-fg-muted">{t('sync.sheet.last')}</dt>
          <dd data-testid="sync-sheet-last">
            {s.lastSyncedAt
              ? new Date(s.lastSyncedAt).toLocaleString('en-IN')
              : t('sync.sheet.never')}
          </dd>
          <dt className="text-fg-muted">{t('sync.sheet.queued')}</dt>
          <dd data-testid="sync-sheet-queued">{s.pending}</dd>
          <dt className="text-fg-muted">{t('sync.sheet.conflicts')}</dt>
          <dd>{facts.data?.conflicts ?? 0}</dd>
        </dl>
        {s.errors.length > 0 && (
          <ul
            className="max-h-32 overflow-auto rounded bg-surface-2 p-2 text-xs"
            data-testid="sync-sheet-errors"
          >
            {s.errors.slice(0, 5).map((e) => (
              <li key={e.at}>{`${new Date(e.at).toLocaleTimeString('en-IN')}: ${e.message}`}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-3">
          <Button
            data-testid="sync-now"
            disabled={!canSyncNow() || !s.connected}
            onClick={() => void runSyncNow()}
          >
            {t('sync.sheet.now')}
          </Button>
          {(facts.data?.conflicts ?? 0) > 0 && (
            <Button
              variant="secondary"
              data-testid="sync-open-conflicts"
              onClick={() => navigate(`/${shell}/inbox`, { kind: 'sync_conflict' })}
            >
              {t('sync.sheet.openConflicts')}
            </Button>
          )}
        </div>
        {!s.attached && <p className="pt-2 text-xs text-fg-muted">{t('sync.sheet.notAttached')}</p>}
      </PopoverContent>
    </Popover>
  );
}
