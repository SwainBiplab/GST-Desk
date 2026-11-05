import { TrashRepo } from '@gst/db';
import { Button, Card } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  autoBackupIfDue,
  downloadNewBackup,
  reminderDue,
  snoozeReminder,
  useBackupStatus,
} from './backup-service';

import { useAppDb } from '@/app/db';
import { forgetPrevious, previousLocation, removeLocationFiles } from '@/app/db-location';
import { isTauri } from '@/app/sqlite/backends';

const HALF_HOUR = 30 * 60_000;
const WEEK = 7 * 86_400_000;

/**
 * Quiet jobs while the app is open: the daily backup when it is due, emptying a trash that has held
 * things for 30 days, and removing the copy of the database that a restore replaced once it has been
 * kept for a week. Nothing here shows anything unless it fails (the bell then says so).
 */
export function BackgroundJobs() {
  const { database, ctx, persistent } = useAppDb();
  useEffect(() => {
    if (!database || !ctx) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        if (persistent) await autoBackupIfDue(database, ctx);
        await new TrashRepo(database).purgeExpired(ctx);
        const prev = previousLocation();
        if (prev && Date.now() - prev.since > WEEK) {
          const loc = forgetPrevious();
          if (loc) await removeLocationFiles(loc);
        }
      } catch (e) {
        console.warn('background job failed', e);
      }
    };
    const first = setTimeout(() => void tick(), 4000);
    const every = setInterval(() => void tick(), HALF_HOUR);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [database, ctx, persistent]);
  return null;
}

/**
 * In the browser, where nothing can back up to a folder on its own: a reminder, every 7 days, to
 * download a copy, because clearing the browser's data erases everything stored here.
 */
export function DownloadReminder() {
  const { t } = useTranslation();
  const { database, persistent } = useAppDb();
  const status = useBackupStatus();
  // the clock is read when the dashboard opens; a download made since then moves the last download past it
  const [now] = useState(() => Date.now());
  if (isTauri() || !database || !persistent || !reminderDue(now)) return null;
  const days = Math.max(
    0,
    Math.floor((now - Math.max(status.lastDownloadAt ?? 0, status.sinceAt)) / 86_400_000),
  );
  return (
    <Card className="mb-4 border-warning" data-testid="download-reminder" role="note">
      <p className="text-sm">{t('data.reminder.body', { count: days })}</p>
      <div className="flex gap-2 pt-2">
        <Button data-testid="reminder-download" onClick={() => void downloadNewBackup(database)}>
          {t('data.reminder.download')}
        </Button>
        <Button variant="ghost" data-testid="reminder-later" onClick={() => snoozeReminder(1)}>
          {t('data.reminder.later')}
        </Button>
      </div>
    </Card>
  );
}
