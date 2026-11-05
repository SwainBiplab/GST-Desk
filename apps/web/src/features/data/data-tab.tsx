import {
  businessDataFromBackup,
  importBusinessData,
  type BackupProgress,
  type ImportResult,
  type Preflight,
} from '@gst/db';
import { announce, TABLES } from '@gst/db';
import { isClockTime } from '@gst/domain';
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cloudUploadIfEnabled,
  downloadNewBackup,
  downloadStored,
  exportCsv,
  exportJson,
  importJson,
  preflight,
  previewImport,
  readSchedule,
  restoreInBrowser,
  runBackup,
  useBackupStatus,
  writeSchedule,
} from './backup-service';
import {
  canChooseFolder,
  canKeepBackups,
  chooseFolder,
  clearFolder,
  deleteBackup,
  folderHandle,
  folderPermission,
  listBackups,
  readBackup,
  type BackupEntry,
} from './backup-store';
import { CloudCard } from './cloud-card';
import { takePendingRestore, usePendingRestore } from './pending-restore';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb } from '@/app/db';
import { isTauri } from '@/app/sqlite/backends';
import { track } from '@/features/telemetry/telemetry';

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const mb = (bytes: number) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Progress({ p }: { p: BackupProgress | null }) {
  const { t } = useTranslation();
  if (!p) return null;
  return (
    <p className="text-sm text-fg-muted" role="status" data-testid="data-progress">
      {t('data.progress', {
        stage: t(`data.stage.${p.stage}`, { defaultValue: p.stage }),
        done: p.done,
        total: p.total,
      })}
    </p>
  );
}

/* ------------------------------------------------------------------ restore */

interface Source {
  label: string;
  bytes: Uint8Array;
}

function RestoreDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [pre, setPre] = useState<Preflight | null>(null);
  const [mode, setMode] = useState<'replace' | 'one'>('replace');
  const [businessId, setBusinessId] = useState<string>('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void preflight(source.bytes).then((p) => {
      if (!live) return;
      setPre(p);
      setBusinessId(p.manifest?.businesses[0]?.id ?? '');
    });
    return () => {
      live = false;
    };
  }, [source]);

  const manifest = pre?.manifest ?? null;

  const restoreAll = async () => {
    if (!database) return;
    setBusy(true);
    setError(null);
    try {
      // keep what is here as it is now, in case the person changes their mind
      await runBackup(database, 'manual', setProgress).catch(() => undefined);
      await restoreInBrowser(source.bytes, setProgress);
      toast.success(t('data.restore.done'));
      window.location.reload();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const addOne = async () => {
    if (!database || !ctx || !manifest) return;
    setBusy(true);
    setError(null);
    try {
      const data = businessDataFromBackup(source.bytes, { manifest }, businessId);
      const r = await importBusinessData(database, data, { orgId: ctx.orgId, actor: ctx.actor });
      announce(
        database,
        TABLES.map((x) => x.name),
      );
      toast.success(t('data.restore.addedOne', { rows: r.rows }));
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-auto" data-testid="restore-dialog">
        <DialogTitle className="text-lg font-semibold">{t('data.restore.title')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{source.label}</DialogDescription>

        {!pre ? (
          <p className="py-3 text-sm text-fg-muted">{t('data.restore.checking')}</p>
        ) : (
          <div className="flex flex-col gap-3 py-2 text-sm" data-testid="restore-preflight">
            {pre.problems.length > 0 && (
              <ul
                className="rounded-md border border-danger p-3 text-danger"
                role="alert"
                data-testid="restore-problems"
              >
                {pre.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {pre.warnings.length > 0 && (
              <ul className="rounded-md border border-warning p-3" data-testid="restore-warnings">
                {pre.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {manifest && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-fg-muted">{t('data.restore.madeOn')}</dt>
                <dd data-testid="restore-made">{when(Date.parse(manifest.createdAt))}</dd>
                <dt className="text-fg-muted">{t('data.restore.businesses')}</dt>
                <dd data-testid="restore-businesses">
                  {manifest.businesses.map((b) => b.tradeName ?? b.legalName).join(', ') ||
                    t('data.restore.none')}
                </dd>
                <dt className="text-fg-muted">{t('data.restore.contents')}</dt>
                <dd data-testid="restore-contents">
                  {t('data.restore.counts', {
                    rows: manifest.totals.rows,
                    files: manifest.totals.attachments,
                  })}
                </dd>
              </dl>
            )}
            {pre.ok && manifest && (
              <fieldset className="flex flex-col gap-2 pt-1">
                <legend className="pb-1 font-medium">{t('data.restore.how')}</legend>
                <div className="flex items-start gap-2">
                  <input
                    id="restore-mode-replace"
                    type="radio"
                    name="restore-mode"
                    className="mt-1"
                    data-testid="restore-mode-replace"
                    aria-describedby="restore-mode-replace-help"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                  />
                  <div>
                    <label htmlFor="restore-mode-replace" className="block font-medium">
                      {t('data.restore.replace')}
                    </label>
                    <p id="restore-mode-replace-help" className="text-fg-muted">
                      {t('data.restore.replaceHelp')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <input
                    id="restore-mode-one"
                    type="radio"
                    name="restore-mode"
                    className="mt-1"
                    data-testid="restore-mode-one"
                    aria-describedby="restore-mode-one-help"
                    checked={mode === 'one'}
                    disabled={manifest.businesses.length === 0}
                    onChange={() => setMode('one')}
                  />
                  <div>
                    <label htmlFor="restore-mode-one" className="block font-medium">
                      {t('data.restore.addOne')}
                    </label>
                    <p id="restore-mode-one-help" className="text-fg-muted">
                      {t('data.restore.addOneHelp')}
                    </p>
                  </div>
                </div>
                {mode === 'one' && (
                  <Select value={businessId} onValueChange={setBusinessId}>
                    <SelectTrigger
                      aria-label={t('data.restore.pickBusiness')}
                      data-testid="restore-business"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {manifest.businesses.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.tradeName ?? b.legalName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {mode === 'replace' && (
                  <label className="flex items-start gap-2 pt-1">
                    <Checkbox
                      checked={agreed}
                      data-testid="restore-agree"
                      onCheckedChange={(v) => setAgreed(v === true)}
                    />
                    <span>{t('data.restore.agree')}</span>
                  </label>
                )}
              </fieldset>
            )}
          </div>
        )}

        <Progress p={progress} />
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="restore-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('data.cancel')}
          </Button>
          <Button
            data-testid="restore-go"
            disabled={busy || !pre?.ok || (mode === 'replace' ? !agreed : !businessId)}
            onClick={() => void (mode === 'replace' ? restoreAll() : addOne())}
          >
            {busy
              ? t('data.restore.working')
              : mode === 'replace'
                ? t('data.restore.goReplace')
                : t('data.restore.goAdd')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ import */

function ImportDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!database || !ctx) return;
    let live = true;
    previewImport(database, ctx, text).then(
      (r) => live && setPreview(r),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [database, ctx, text]);

  const go = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const r = await importJson(database, ctx, text);
      toast.success(t('data.import.done', { rows: r.rows }));
      track('import_done');
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-auto" data-testid="import-dialog">
        <DialogTitle className="text-lg font-semibold">{t('data.import.title')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{t('data.import.help')}</DialogDescription>
        {error ? (
          <p role="alert" className="text-sm text-danger" data-testid="import-error">
            {error}
          </p>
        ) : !preview ? (
          <p className="py-3 text-sm text-fg-muted">{t('data.restore.checking')}</p>
        ) : (
          <div className="text-sm" data-testid="import-preview">
            <p className="pb-2" data-testid="import-summary">
              {t('data.import.summary', { rows: preview.rows, ids: preview.idsMapped })}
            </p>
            <table className="w-full">
              <tbody>
                {Object.entries(preview.tables)
                  .filter(([, n]) => n > 0)
                  .map(([name, n]) => (
                    <tr key={name} className="border-t border-border">
                      <td className="py-1">{name}</td>
                      <td className="tabular py-1 text-right" data-testid={`import-count-${name}`}>
                        {n}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {preview.warnings.length > 0 && (
              <ul className="pt-2 text-fg-muted">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('data.cancel')}
          </Button>
          <Button data-testid="import-go" disabled={busy || !preview} onClick={() => void go()}>
            {t('data.import.go')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ the tab */

/** Settings, Backup: backups and restore, export and import, and (desktop) the cloud drive. */
export function DataTab() {
  const { t } = useTranslation();
  const { database, ctx, business, persistent } = useAppDb();
  const confirm = useConfirm();
  const status = useBackupStatus();
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [canKeep, setCanKeep] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderAllowed, setFolderAllowed] = useState(true);
  const [busy, setBusy] = useState<null | 'backup' | 'download' | 'json' | 'csv'>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [restoring, setRestoring] = useState<Source | null>(null);
  // a backup opened from the file manager shows up here; the dialog still asks before anything is restored
  const waiting = usePendingRestore();
  const shown = restoring ?? waiting;
  const [importText, setImportText] = useState<string | null>(null);
  const [schedule, setSchedule] = useState(readSchedule);
  const restoreInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(0);
  const desktop = isTauri();
  const businessName = String(business?.['trade_name'] ?? business?.['legal_name'] ?? 'business');

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [list, keep, f] = await Promise.all([listBackups(), canKeepBackups(), folderHandle()]);
      const allowed = f ? (await folderPermission(f, false)) === 'granted' : true;
      if (!live) return;
      setBackups(list);
      setCanKeep(keep);
      setFolder(f?.name ?? null);
      setFolderAllowed(allowed);
    })();
    return () => {
      live = false;
    };
  }, [version, status.lastAt]);

  const run = async (kind: 'backup' | 'download') => {
    if (!database) return;
    setBusy(kind);
    setProgress(null);
    try {
      if (kind === 'backup') {
        const r = await runBackup(database, 'manual', setProgress);
        if (ctx) await cloudUploadIfEnabled(database, ctx, r.name, r.bytes);
        toast.success(t('data.backup.made', { size: mb(r.bytes.length) }));
      } else {
        await downloadNewBackup(database, setProgress);
        toast.success(t('data.backup.downloaded'));
      }
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const updateSchedule = (next: typeof schedule) => {
    setSchedule(next);
    writeSchedule(next);
  };

  const openRestore = async (name: string) => {
    const bytes = await readBackup(name);
    if (!bytes) return toast.error(t('data.backup.unreadable'));
    setRestoring({ label: name, bytes });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="section-backup">
      {!desktop && (
        <p
          className="rounded-md border border-warning p-3 text-sm"
          data-testid="browser-warning"
          role="note"
        >
          {t('data.browserWarning')}
        </p>
      )}
      {!persistent && (
        <p
          className="rounded-md border border-danger p-3 text-sm text-danger"
          role="alert"
          data-testid="not-persistent"
        >
          {t('data.notPersistent')}
        </p>
      )}

      <Card>
        <CardTitle>{t('data.backup.title')}</CardTitle>
        <p className="pt-1 text-sm text-fg-muted" data-testid="backup-last">
          {status.lastAt
            ? t('data.backup.last', {
                when: when(status.lastAt),
                size: mb(status.bytes),
                rows: status.rows,
              })
            : t('data.backup.never')}
        </p>
        {!status.ok && status.error && (
          <p role="alert" className="pt-1 text-sm text-danger" data-testid="backup-failed">
            {t('data.backup.failed', { reason: status.error })}
          </p>
        )}
        {status.folderError && (
          <p className="pt-1 text-sm text-warning" data-testid="backup-folder-error">
            {status.folderError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <Button
            data-testid="backup-now"
            disabled={busy !== null || !canKeep || !database}
            onClick={() => void run('backup')}
          >
            {busy === 'backup' ? t('data.backup.working') : t('data.backup.now')}
          </Button>
          <Button
            variant="outline"
            data-testid="backup-download"
            disabled={busy !== null || !database}
            onClick={() => void run('download')}
          >
            {t('data.backup.download')}
          </Button>
          <Button
            variant="outline"
            data-testid="restore-from-file-open"
            onClick={() => restoreInput.current?.click()}
          >
            {t('data.restore.fromFile')}
          </Button>
          <input
            ref={restoreInput}
            type="file"
            accept=".gstbk,application/zip"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('data.restore.fromFile')}
            data-testid="restore-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f)
                void f
                  .arrayBuffer()
                  .then((b) => setRestoring({ label: f.name, bytes: new Uint8Array(b) }));
            }}
          />
        </div>
        <Progress p={progress} />

        <div className="grid gap-3 pt-4 md:grid-cols-2">
          <div className="text-sm">
            <p className="font-medium">{t('data.folder.title')}</p>
            {canChooseFolder() ? (
              <>
                <p className="py-1 text-fg-muted" data-testid="folder-name">
                  {folder ? t('data.folder.using', { name: folder }) : t('data.folder.none')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    data-testid="folder-choose"
                    onClick={() =>
                      void chooseFolder().then((n) => {
                        if (n) toast.success(t('data.folder.chosen', { name: n }));
                        void refresh();
                      })
                    }
                  >
                    {folder ? t('data.folder.change') : t('data.folder.choose')}
                  </Button>
                  {folder && !folderAllowed && (
                    <Button
                      variant="outline"
                      data-testid="folder-allow"
                      onClick={() =>
                        void folderHandle().then(async (h) => {
                          if (h) await folderPermission(h, true);
                          void refresh();
                        })
                      }
                    >
                      {t('data.folder.allow')}
                    </Button>
                  )}
                  {folder && (
                    <Button
                      variant="ghost"
                      data-testid="folder-clear"
                      onClick={() => void clearFolder().then(refresh)}
                    >
                      {t('data.folder.stop')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="py-1 text-fg-muted">{t('data.folder.unsupported')}</p>
            )}
          </div>

          <div className="text-sm">
            <p className="font-medium">{t('data.schedule.title')}</p>
            <label className="flex items-center gap-2 py-1">
              <Checkbox
                checked={schedule.enabled}
                data-testid="schedule-enabled"
                onCheckedChange={(v) => updateSchedule({ ...schedule, enabled: v === true })}
              />
              {t('data.schedule.enabled')}
            </label>
            <label className="flex items-center gap-2">
              <span className="text-fg-muted">{t('data.schedule.when')}</span>
              <Select
                value={schedule.time === null ? 'first' : 'at'}
                onValueChange={(v) =>
                  updateSchedule({
                    ...schedule,
                    time: v === 'first' ? null : (schedule.time ?? '02:00'),
                  })
                }
              >
                <SelectTrigger
                  className="w-56"
                  aria-label={t('data.schedule.when')}
                  data-testid="schedule-mode"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first">{t('data.schedule.first')}</SelectItem>
                  <SelectItem value="at">{t('data.schedule.at')}</SelectItem>
                </SelectContent>
              </Select>
              {schedule.time !== null && (
                <Input
                  type="time"
                  className="w-28"
                  value={schedule.time}
                  data-testid="schedule-time"
                  aria-label={t('data.schedule.time')}
                  onChange={(e) =>
                    isClockTime(e.target.value) &&
                    updateSchedule({ ...schedule, time: e.target.value })
                  }
                />
              )}
            </label>
            <p className="pt-1 text-fg-muted">{t('data.schedule.keeps')}</p>
          </div>
        </div>

        <h3 className="pt-5 text-sm font-semibold">{t('data.list.title')}</h3>
        {backups.length === 0 ? (
          <p className="pt-1 text-sm text-fg-muted" data-testid="backup-empty">
            {t('data.list.empty')}
          </p>
        ) : (
          <table className="mt-1 w-full text-sm" data-testid="backup-list">
            <thead className="text-left text-xs uppercase text-fg-muted">
              <tr>
                <th className="py-1 font-medium">{t('data.list.when')}</th>
                <th className="py-1 font-medium">{t('data.list.kind')}</th>
                <th className="py-1 text-right font-medium">{t('data.list.size')}</th>
                <th className="py-1 font-medium">{t('data.list.status')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr
                  key={b.name}
                  className="border-t border-border"
                  data-testid="backup-row"
                  data-name={b.name}
                >
                  <td className="py-1">{when(b.at)}</td>
                  <td className="py-1">{t(`data.kind.${b.kind}`)}</td>
                  <td className="tabular py-1 text-right">{mb(b.size)}</td>
                  <td className="py-1">{t('data.list.checked')}</td>
                  <td className="whitespace-nowrap py-1 text-right">
                    <Button
                      variant="ghost"
                      data-testid="backup-download-row"
                      onClick={() => void downloadStored(b.name)}
                    >
                      {t('data.list.download')}
                    </Button>
                    <Button
                      variant="ghost"
                      data-testid="backup-restore-row"
                      onClick={() => void openRestore(b.name)}
                    >
                      {t('data.list.restore')}
                    </Button>
                    <Button
                      variant="ghost"
                      data-testid="backup-delete-row"
                      onClick={() =>
                        void confirm({
                          title: t('data.list.deleteTitle'),
                          description: t('data.list.deleteBody'),
                          confirmLabel: t('data.list.delete'),
                        }).then(async (ok) => {
                          if (ok) {
                            await deleteBackup(b.name);
                            void refresh();
                          }
                        })
                      }
                    >
                      {t('data.list.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardTitle>{t('data.export.title')}</CardTitle>
        <p className="pt-1 text-sm text-fg-muted">
          {t('data.export.help', { name: businessName })}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <Button
            variant="outline"
            data-testid="export-json"
            disabled={busy !== null || !ctx}
            onClick={() => {
              if (!database || !ctx) return;
              setBusy('json');
              void exportJson(database, ctx, businessName)
                .catch((e) => toast.error(errText(e)))
                .finally(() => setBusy(null));
            }}
          >
            {t('data.export.json')}
          </Button>
          <Button
            variant="outline"
            data-testid="export-csv"
            disabled={busy !== null || !ctx}
            onClick={() => {
              if (!database || !ctx) return;
              setBusy('csv');
              void exportCsv(database, ctx, businessName)
                .catch((e) => toast.error(errText(e)))
                .finally(() => setBusy(null));
            }}
          >
            {t('data.export.csv')}
          </Button>
          <Button
            variant="outline"
            data-testid="import-open"
            onClick={() => importInput.current?.click()}
          >
            {t('data.import.choose')}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('data.import.choose')}
            data-testid="import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void f.text().then(setImportText);
            }}
          />
        </div>
        <p className="pt-2 text-xs text-fg-muted">{t('data.export.noSecrets')}</p>
      </Card>

      <CloudCard />

      {shown && (
        <RestoreDialog
          source={shown}
          onClose={() => {
            takePendingRestore();
            setRestoring(null);
            void refresh();
          }}
        />
      )}
      {importText !== null && (
        <ImportDialog text={importText} onClose={() => setImportText(null)} />
      )}
    </div>
  );
}
