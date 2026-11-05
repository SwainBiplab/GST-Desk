import { SettingsRepo } from '@gst/db';
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CLOUD_KEY, readCloud, useBackupStatus, type CloudSettings } from './backup-service';
import { listBackups, readBackup } from './backup-store';
import { uploadBackup, type CloudProvider } from './cloud';

import { useAppDb } from '@/app/db';
import { isTauri } from '@/app/sqlite/backends';

const empty: CloudSettings = {
  enabled: false,
  provider: 'google',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
};

/**
 * Optional copies of each backup to the person's own Google Drive or OneDrive, using an app they set
 * up themselves. Desktop only: the browser cannot hold a refresh token safely.
 */
export function CloudCard() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const status = useBackupStatus();
  const desktop = isTauri();
  const [form, setForm] = useState<CloudSettings>(empty);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!desktop || !database || !ctx) return;
    void readCloud(database, ctx).then((c) => c && setForm({ ...empty, ...c }));
  }, [desktop, database, ctx]);

  if (!desktop) {
    return (
      <Card data-testid="cloud-card">
        <CardTitle>{t('data.cloud.title')}</CardTitle>
        <p className="pt-1 text-sm text-fg-muted" data-testid="cloud-desktop-only">
          {t('data.cloud.desktopOnly')}
        </p>
      </Card>
    );
  }

  const save = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      await new SettingsRepo(database).set(ctx, CLOUD_KEY, form);
      toast.success(t('data.cloud.saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const newest = (await listBackups())[0];
      const bytes = newest ? await readBackup(newest.name) : null;
      if (!newest || !bytes) throw new Error(t('data.cloud.noBackup'));
      await uploadBackup(form, newest.name, bytes);
      toast.success(t('data.cloud.tested', { name: newest.name }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<CloudSettings>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Card data-testid="cloud-card">
      <CardTitle>{t('data.cloud.title')}</CardTitle>
      <p className="pt-1 text-sm text-fg-muted">{t('data.cloud.help')}</p>
      <div className="grid gap-3 pt-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="block pb-1 text-fg-muted">{t('data.cloud.provider')}</span>
          <Select
            value={form.provider}
            onValueChange={(v) => set({ provider: v as CloudProvider })}
          >
            <SelectTrigger aria-label={t('data.cloud.provider')} data-testid="cloud-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="google">Google Drive</SelectItem>
              <SelectItem value="onedrive">OneDrive</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="text-sm">
          <span className="block pb-1 text-fg-muted">{t('data.cloud.clientId')}</span>
          <Input
            value={form.clientId}
            data-testid="cloud-client-id"
            onChange={(e) => set({ clientId: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="block pb-1 text-fg-muted">{t('data.cloud.clientSecret')}</span>
          <Input
            type="password"
            autoComplete="off"
            value={form.clientSecret ?? ''}
            data-testid="cloud-client-secret"
            onChange={(e) => set({ clientSecret: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="block pb-1 text-fg-muted">{t('data.cloud.refreshToken')}</span>
          <Input
            type="password"
            autoComplete="off"
            value={form.refreshToken}
            data-testid="cloud-refresh-token"
            onChange={(e) => set({ refreshToken: e.target.value })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 pt-3 text-sm">
        <Checkbox
          checked={form.enabled}
          data-testid="cloud-enabled"
          onCheckedChange={(v) => set({ enabled: v === true })}
        />
        {t('data.cloud.enabled')}
      </label>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button data-testid="cloud-save" disabled={busy} onClick={() => void save()}>
          {t('data.cloud.save')}
        </Button>
        <Button
          variant="outline"
          data-testid="cloud-test"
          disabled={busy || !form.clientId || !form.refreshToken}
          onClick={() => void test()}
        >
          {t('data.cloud.test')}
        </Button>
      </div>
      {status.cloudError && (
        <p role="alert" className="pt-2 text-sm text-danger" data-testid="cloud-error">
          {status.cloudError}
        </p>
      )}
      <p className="pt-2 text-xs text-fg-muted">{t('data.cloud.secret')}</p>
    </Card>
  );
}
