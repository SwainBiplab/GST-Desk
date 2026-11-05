import {
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@gst/ui';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { open as pickFolder, save as pickFile } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  dataPaths,
  diagnosticsZip,
  listPrinters,
  moveData,
  openDataDir,
  updateCheck,
  type DataPaths,
} from './bridge';
import { CHANNEL_KEY, LAST_CHECK_KEY, readChannel, type Channel } from './logic';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

/** Settings for the desktop app: where the data is, updates, starting with the computer, printers, and a problem report. */
export function DesktopTab() {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [printers, setPrinters] = useState<string[] | null>(null);
  const [launch, setLaunch] = useState<boolean | null>(null);
  const [channel, setChannel] = useState<Channel>(() => readChannel(store.get));
  const [checking, setChecking] = useState(false);
  const [moving, setMoving] = useState<{ target: string | null; busy: boolean } | null>(null);

  const loadPrinters = () =>
    void listPrinters()
      .then(setPrinters)
      .catch(() => setPrinters([]));
  useEffect(() => {
    void dataPaths()
      .then(setPaths)
      .catch(() => undefined);
    void isEnabled()
      .then(setLaunch)
      .catch(() => setLaunch(false));
    loadPrinters();
  }, []);

  const checkNow = async () => {
    setChecking(true);
    try {
      const found = await updateCheck(channel);
      store.set(LAST_CHECK_KEY, String(Date.now()));
      if (found) {
        toast(t('desktop.update.ready', { version: found.version }));
        window.dispatchEvent(new CustomEvent('gst:update-found', { detail: found }));
      } else toast.success(t('desktop.update.upToDate', { version: '' }).replace('()', '').trim());
    } catch (e) {
      toast.error(t('desktop.update.failed', { message: errText(e) }));
    } finally {
      setChecking(false);
    }
  };

  const chooseTarget = async () => {
    const dir = await pickFolder({
      directory: true,
      multiple: false,
      title: t('desktop.data.choose'),
    });
    if (typeof dir === 'string') setMoving({ target: dir, busy: false });
  };

  const doMove = async () => {
    if (!moving?.target || !paths) return;
    setMoving({ ...moving, busy: true });
    try {
      const old = paths.root;
      await moveData(moving.target);
      toast.success(t('desktop.data.moved', { old }), { duration: 20_000 });
      // the database is closed: open it again from the new place
      window.location.reload();
    } catch (e) {
      toast.error(errText(e));
      setMoving({ ...moving, busy: false });
    }
  };

  const report = async () => {
    const dest = await pickFile({
      defaultPath: t('desktop.problem.file'),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (!dest) return;
    try {
      const n = await diagnosticsZip(dest, `channel: ${channel}`);
      toast.success(t('desktop.problem.saved', { count: n, path: dest }));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="desktop-tab">
      <Card>
        <h2 className="font-medium">{t('desktop.data.title')}</h2>
        {paths && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 py-2 text-sm">
            <dt className="text-fg-muted">{t('desktop.data.where')}</dt>
            <dd className="break-all" data-testid="data-root">
              {paths.root}
            </dd>
            <dt className="text-fg-muted">{t('desktop.data.backups')}</dt>
            <dd className="break-all">{paths.backups}</dd>
            <dt className="text-fg-muted">{t('desktop.data.documents')}</dt>
            <dd className="break-all">{paths.documents}</dd>
          </dl>
        )}
        {paths?.isDefault && (
          <p className="text-xs text-fg-muted">{t('desktop.data.defaultNote')}</p>
        )}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" data-testid="open-data" onClick={() => void openDataDir()}>
            {t('desktop.data.open')}
          </Button>
          <Button
            variant="outline"
            data-testid="move-data"
            onClick={() => setMoving({ target: null, busy: false })}
          >
            {t('desktop.data.move')}
          </Button>
        </div>
        {moving && (
          <div
            className="mt-3 rounded-md border border-border p-3 text-sm"
            data-testid="move-wizard"
          >
            <p className="font-medium">{t('desktop.data.moveTitle')}</p>
            <p className="py-1 text-fg-muted">{t('desktop.data.moveHelp')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" disabled={moving.busy} onClick={() => void chooseTarget()}>
                {t('desktop.data.choose')}
              </Button>
              {moving.target && (
                <span className="break-all">
                  {t('desktop.data.chosen', { path: moving.target })}
                </span>
              )}
            </div>
            <div className="flex gap-2 pt-3">
              <Button
                disabled={!moving.target || moving.busy}
                data-testid="move-confirm"
                onClick={() => void doMove()}
              >
                {moving.busy ? t('desktop.data.moving') : t('desktop.data.confirm')}
              </Button>
              <Button variant="ghost" disabled={moving.busy} onClick={() => setMoving(null)}>
                {t('confirm.cancel')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium">{t('desktop.update.check')}</h2>
        <div className="flex flex-wrap items-center gap-3 py-2">
          <label className="text-sm" htmlFor="update-channel">
            {t('desktop.update.channel')}
          </label>
          <Select
            value={channel}
            onValueChange={(v) => {
              setChannel(v as Channel);
              store.set(CHANNEL_KEY, v);
            }}
          >
            <SelectTrigger id="update-channel" className="w-56" data-testid="update-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">{t('desktop.update.stable')}</SelectItem>
              <SelectItem value="beta">{t('desktop.update.beta')}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={checking}
            data-testid="update-check"
            onClick={() => void checkNow()}
          >
            {checking ? t('desktop.update.checking') : t('desktop.update.check')}
          </Button>
        </div>
        <p className="text-xs text-fg-muted">{t('desktop.update.channelHelp')}</p>
        <p className="text-xs text-fg-muted">{t('desktop.update.kept')}</p>
      </Card>

      <Card>
        <h2 className="font-medium">{t('desktop.startup.title')}</h2>
        <label className="flex items-center gap-2 py-2 text-sm">
          <Switch
            checked={!!launch}
            disabled={launch === null}
            data-testid="launch-at-login"
            onCheckedChange={(on) => {
              setLaunch(on);
              void (on ? enable() : disable()).catch((e: unknown) => {
                setLaunch(!on);
                toast.error(errText(e));
              });
            }}
          />
          {t('desktop.startup.launch')}
        </label>
        <p className="text-xs text-fg-muted">{t('desktop.startup.launchHelp')}</p>
      </Card>

      <Card>
        <h2 className="font-medium">{t('desktop.printers.title')}</h2>
        <p className="py-1 text-sm text-fg-muted">{t('desktop.printers.help')}</p>
        {printers && printers.length === 0 ? (
          <p className="text-sm" data-testid="no-printers">
            {t('desktop.printers.none')}
          </p>
        ) : (
          <ul className="list-disc pl-5 text-sm" data-testid="printer-list">
            {printers?.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Button variant="ghost" className="mt-2" onClick={loadPrinters}>
          {t('desktop.printers.refresh')}
        </Button>
      </Card>

      <Card>
        <h2 className="font-medium">{t('desktop.problem.title')}</h2>
        <p className="py-1 text-sm text-fg-muted">{t('desktop.problem.help')}</p>
        <Button variant="outline" data-testid="report-problem" onClick={() => void report()}>
          {t('desktop.problem.save')}
        </Button>
      </Card>
    </div>
  );
}
