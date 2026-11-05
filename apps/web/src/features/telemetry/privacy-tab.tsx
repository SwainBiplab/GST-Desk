import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Card,
  Switch,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FEATURES } from './core';
import { hasAddress, resetId, setOn, usePending, useTelemetryOn } from './telemetry';

import { useAppDb } from '@/app/db';
import { canResetLocalData, resetLocalData } from '@/app/reset-local';
import { isDesktop } from '@/features/desktop/bridge';

/** Settings, Privacy: what is collected (nothing unless you say so), what would be sent, and your data. */
export function PrivacyTab() {
  const { t } = useTranslation();
  const on = useTelemetryOn();
  const pending = usePending();
  const { database } = useAppDb();
  const [confirming, setConfirming] = useState(false);

  const wipe = async () => {
    try {
      // the open database holds its files; close it first or they cannot be removed
      await database?.close().catch(() => undefined);
      await resetLocalData();
      window.location.assign('/');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="privacy-tab">
      <Card>
        <h2 className="font-medium">{t('privacy.usage.title')}</h2>
        <p className="py-2 text-sm text-fg-muted">{t('privacy.usage.body')}</p>
        <label className="flex items-center gap-2 py-1 text-sm">
          <Switch checked={on} data-testid="telemetry-switch" onCheckedChange={setOn} />
          {t('privacy.usage.switch')}
        </label>
        <p className="pt-1 text-xs text-fg-muted" data-testid="telemetry-state">
          {on
            ? hasAddress()
              ? t('privacy.usage.onSending')
              : t('privacy.usage.onNoAddress')
            : t('privacy.usage.off')}
        </p>
        <p className="pt-3 text-sm font-medium">{t('privacy.usage.counted')}</p>
        <p className="text-xs text-fg-muted" data-testid="telemetry-features">
          {FEATURES.join(', ')}
        </p>
        {on && (
          <>
            <p className="pt-3 text-sm font-medium">{t('privacy.usage.wouldSend')}</p>
            <pre
              className="overflow-auto rounded-md bg-surface-2 p-2 text-xs"
              data-testid="telemetry-payload"
            >
              {pending}
            </pre>
            <Button variant="ghost" className="mt-2" onClick={resetId}>
              {t('privacy.usage.resetId')}
            </Button>
          </>
        )}
      </Card>

      <Card>
        <h2 className="font-medium">{t('privacy.data.title')}</h2>
        <p className="py-2 text-sm text-fg-muted">{t('privacy.data.body')}</p>
        <p className="text-sm">{t('privacy.data.export')}</p>
        <p className="pt-1 text-sm">
          {isDesktop() ? t('privacy.data.deleteDesktop') : t('privacy.data.deleteWeb')}
        </p>
        {canResetLocalData() && !isDesktop() && (
          <Button
            variant="outline"
            className="mt-3"
            data-testid="delete-all"
            onClick={() => setConfirming(true)}
          >
            {t('privacy.data.deleteButton')}
          </Button>
        )}
      </Card>

      {confirming && (
        <AlertDialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <AlertDialogContent data-testid="delete-all-dialog">
            <AlertDialogTitle>{t('empty.reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('empty.reset.body')}</AlertDialogDescription>
            <div className="flex justify-end gap-2 pt-3">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('confirm.cancel')}
              </Button>
              <Button data-testid="delete-all-confirm" onClick={() => void wipe()}>
                {t('empty.reset.confirm')}
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
