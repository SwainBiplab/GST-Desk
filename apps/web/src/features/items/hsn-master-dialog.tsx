import { SettingsRepo } from '@gst/db';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useHsnVersions } from './hooks';

import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';
import { HSN_UPDATE_KEY, checkForHsnUpdate, isAllowedUpdateUrl } from '@/lib/hsn';

/**
 * The HSN/SAC master: which versions are installed, and the optional address to check for newer
 * signed versions. The address is empty by default, so nothing is fetched until the owner sets one.
 */
export function HsnMasterDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const versions = useHsnVersions().data ?? [];
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = url.trim() !== '' && !isAllowedUpdateUrl(url.trim());

  useEffect(() => {
    if (!database || !ctx) return;
    void new SettingsRepo(database).getValue<string>(ctx, HSN_UPDATE_KEY).then((v) => {
      setUrl(v ?? '');
      setSaved(v ?? '');
    });
  }, [database, ctx]);

  const save = async () => {
    if (!database || !ctx || invalid) return;
    await new SettingsRepo(database).set(ctx, HSN_UPDATE_KEY, url.trim());
    setSaved(url.trim());
    toast.success(t('items.hsnMaster.saved'));
  };

  const check = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    setMessage('');
    try {
      const r = await checkForHsnUpdate(database, ctx);
      setMessage(
        r.status === 'off'
          ? t('items.hsnMaster.off')
          : r.status === 'current'
            ? t('items.hsnMaster.current', { version: r.version })
            : r.status === 'updated'
              ? t('items.hsnMaster.updated', { version: r.version, count: r.rateChanges })
              : r.status === 'rejected'
                ? t('items.hsnMaster.rejected')
                : t(`items.hsnMaster.error.${r.message}`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(40rem,calc(100vw-2rem))] flex-col gap-3 overflow-auto"
        data-testid="hsn-dialog"
      >
        <DialogTitle className="text-lg font-semibold">{t('items.hsnMaster.title')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{t('items.hsnMaster.help')}</DialogDescription>

        <table className="w-full text-sm" aria-label={t('items.hsnMaster.versions')}>
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              <th className="p-1">{t('items.hsnMaster.version')}</th>
              <th className="p-1">{t('items.hsnMaster.asOf')}</th>
              <th className="p-1">{t('items.hsnMaster.rows')}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className="border-t border-border" data-testid="hsn-version">
                <td className="p-1 font-medium">{v.version}</td>
                <td className="p-1">{v.as_of ?? '-'}</td>
                <td className="p-1 tabular-nums">{v.row_count ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-fg-muted">{t('items.hsnMaster.review')}</p>

        <Field
          label={t('items.hsnMaster.url')}
          error={invalid ? 'hsn_url' : undefined}
          hint={t('items.hsnMaster.urlHelp')}
        >
          {(c) => (
            <Input
              {...c}
              inputMode="url"
              data-testid="hsn-url"
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            data-testid="hsn-url-save"
            disabled={invalid || url.trim() === saved}
            onClick={() => void save()}
          >
            {t('items.hsnMaster.save')}
          </Button>
          <Button
            data-testid="hsn-check"
            disabled={busy || saved === '' || url.trim() !== saved}
            onClick={() => void check()}
          >
            {t('items.hsnMaster.check')}
          </Button>
        </div>
        {message && (
          <p role="status" className="text-sm" data-testid="hsn-message">
            {message}
          </p>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('items.units.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
