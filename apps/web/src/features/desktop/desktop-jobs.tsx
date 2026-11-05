import { Button } from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  isDesktop,
  on,
  readBackupFile,
  basename,
  setTrayLabels,
  takeLaunchRequests,
  updateCheck,
  updateDownload,
  updateInstall,
  type UpdateInfo,
} from './bridge';
import {
  CHANNEL_KEY,
  LAST_CHECK_KEY,
  readChannel,
  readLastCheck,
  routeForLink,
  updateDue,
} from './logic';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { runBackup } from '@/features/data/backup-service';
import { offerRestore } from '@/features/data/pending-restore';

const HOUR = 3_600_000;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/**
 * Everything the desktop shell adds while the app is open: looking for updates (on launch and daily),
 * downloading one in the background and offering "Restart to update", the tray's quick actions, and
 * backups or links the system asked the app to open. In a browser it renders nothing and does nothing.
 */
export function DesktopJobs() {
  const { t, i18n } = useTranslation();
  const { database } = useAppDb();
  const navigate = useAppNavigate();
  const shell = useAppStore((s) => s.shell);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<'idle' | 'downloading' | 'ready'>('idle');
  const [showNotes, setShowNotes] = useState(false);
  const dbRef = useRef(database);
  const shellRef = useRef(shell);
  useEffect(() => {
    dbRef.current = database;
    shellRef.current = shell;
  });

  // updates: check at launch and then daily, download quietly, and let the person choose when to restart
  useEffect(() => {
    if (!isDesktop()) return;
    let stopped = false;
    const found = async (info: UpdateInfo) => {
      if (stopped) return;
      setUpdate(info);
      setState('downloading');
      try {
        await updateDownload();
        if (!stopped) setState('ready');
      } catch (e) {
        console.warn('update download failed', e);
        if (!stopped) setState('idle');
      }
    };
    const check = async (onLaunch: boolean) => {
      if (!updateDue(readLastCheck(read), Date.now(), onLaunch)) return;
      try {
        const info = await updateCheck(readChannel(read));
        try {
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        } catch {
          /* storage may be blocked */
        }
        if (info) await found(info);
      } catch (e) {
        // an unsigned build, no network, or no address: nothing to tell the person
        console.warn('update check failed', e);
      }
    };
    const first = setTimeout(() => void check(true), 8000);
    const every = setInterval(() => void check(false), HOUR);
    const manual = (e: Event) => void found((e as CustomEvent<UpdateInfo>).detail);
    window.addEventListener('gst:update-found', manual);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener('gst:update-found', manual);
    };
  }, []);

  // the tray speaks the language of the screens
  useEffect(() => {
    if (!isDesktop()) return;
    void setTrayLabels({
      'new-bill': t('desktop.tray.newBill'),
      'backup-now': t('desktop.tray.backupNow'),
      'open-data': t('desktop.tray.openData'),
      show: t('desktop.tray.show'),
      quit: t('desktop.tray.quit'),
    }).catch(() => undefined);
  }, [t, i18n.language]);

  // tray actions, and things the system asked the app to open
  useEffect(() => {
    if (!isDesktop()) return;
    const offs: (() => void)[] = [];
    let alive = true;
    const handleRequests = async () => {
      for (const r of await takeLaunchRequests()) {
        if (r.kind === 'link') {
          const route = routeForLink(r.value, shellRef.current);
          if (route) navigate(route.to, route.search);
        } else {
          try {
            const bytes = await readBackupFile(r.value);
            offerRestore({ label: basename(r.value), bytes });
            navigate(`/${shellRef.current}/settings`, { tab: 'backup' });
          } catch (e) {
            console.warn('could not open the backup', e);
          }
        }
      }
    };
    void (async () => {
      const subs = [
        await on('tray:new-bill', () => {
          const route = routeForLink('gstdesk://new-bill', shellRef.current);
          if (route) navigate(route.to, route.search);
        }),
        await on('tray:backup-now', () => {
          const db = dbRef.current;
          if (db) void runBackup(db, 'manual').catch(() => undefined);
        }),
        await on('launch:request', () => void handleRequests()),
      ];
      if (alive) offs.push(...subs);
      else subs.forEach((o) => o());
      void handleRequests();
    })();
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, [navigate]);

  if (!isDesktop() || !update || state === 'idle') return null;
  return (
    <div
      role="status"
      data-testid="desktop-update-bar"
      className="fixed inset-x-0 bottom-0 z-(--z-toast) flex flex-wrap items-center justify-center gap-3 bg-info p-2 text-info-fg"
    >
      <span>
        {state === 'downloading'
          ? t('desktop.update.downloading', { version: update.version })
          : t('desktop.update.ready', { version: update.version })}
      </span>
      {update.notes && (
        <Button variant="ghost" className="text-info-fg" onClick={() => setShowNotes((v) => !v)}>
          {t('desktop.update.notes')}
        </Button>
      )}
      {state === 'ready' && (
        <Button variant="outline" data-testid="update-restart" onClick={() => void updateInstall()}>
          {t('desktop.update.restart')}
        </Button>
      )}
      <Button variant="ghost" className="text-info-fg" onClick={() => setUpdate(null)}>
        {t('desktop.update.later')}
      </Button>
      {showNotes && update.notes && (
        <pre className="w-full max-w-2xl whitespace-pre-wrap rounded-md bg-bg p-2 text-left text-sm text-fg">
          {update.notes}
        </pre>
      )}
    </div>
  );
}

export { CHANNEL_KEY };
