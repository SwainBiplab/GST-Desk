import { DEFAULT_TALLY_NAMES, type TallyExportResult, type TallyNames } from '@gst/interop';
import { Button, Card, Checkbox, Input, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMigrateActions, useTallyNames } from './hooks';

import { fyChoices } from '@/features/direct-tax/hooks';
import { downloadBytes } from '@/features/reports/download';
import { dyn } from '@/lib/dyn-key';

const XML_MIME = 'application/xml;charset=utf-8';
const NAME_KEYS = Object.keys(DEFAULT_TALLY_NAMES) as (keyof TallyNames)[];

/** Send the books to Tally: masters and vouchers for a period, with the ledger names Tally already has. */
export function ExportTab() {
  const { t } = useTranslation();
  const actions = useMigrateActions();
  const saved = useTallyNames();
  const [fy, setFy] = useState(fyChoices()[0]!);
  const [masters, setMasters] = useState(true);
  const [vouchers, setVouchers] = useState(true);
  const [edit, setEdit] = useState<Partial<TallyNames>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    masters: TallyExportResult | null;
    vouchers: TallyExportResult | null;
  } | null>(null);
  const names = { ...saved.names, ...edit };
  const start = Number(fy.slice(0, 4));

  const run = async () => {
    setBusy(true);
    try {
      await saved.save(names);
      const out = await actions.tallyFiles(`${start}-04-01`, `${start + 1}-03-31`, names, {
        masters,
        vouchers,
      });
      if (out.masters) downloadBytes(`Tally_Masters_${fy}.xml`, out.masters.xml, XML_MIME);
      if (out.vouchers) downloadBytes(`Tally_Vouchers_${fy}.xml`, out.vouchers.xml, XML_MIME);
      setDone({ masters: out.masters, vouchers: out.vouchers });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="export-tab">
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t('migrate.export.heading')}</h2>
        <p className="text-sm text-fg-muted">{t('migrate.export.hint')}</p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-muted">{t('migrate.export.year')}</span>
            <select
              className="h-(--control-h) rounded-md border border-border bg-bg px-2"
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              data-testid="export-fy"
            >
              {fyChoices().map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={masters}
              onCheckedChange={(v) => setMasters(v === true)}
              data-testid="export-masters"
            />
            {t('migrate.export.masters')}
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={vouchers}
              onCheckedChange={(v) => setVouchers(v === true)}
              data-testid="export-vouchers"
            />
            {t('migrate.export.vouchers')}
          </label>
        </div>

        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t('migrate.export.names')}
          </summary>
          <p className="py-2 text-sm text-fg-muted">{t('migrate.export.namesHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {NAME_KEYS.map((k) => (
              <label key={k} className="flex flex-col gap-1 text-sm">
                <span className="text-fg-muted">{t(dyn(`migrate.export.nameOf.${k}`))}</span>
                <Input
                  value={names[k]}
                  onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                  data-testid={`name-${k}`}
                />
              </label>
            ))}
          </div>
        </details>

        <div>
          <Button
            disabled={busy || (!masters && !vouchers)}
            onClick={() => void run()}
            data-testid="export-run"
          >
            {t('migrate.export.run')}
          </Button>
        </div>
      </Card>

      {done ? (
        <Card className="flex flex-col gap-2" data-testid="export-result">
          <h3 className="text-base font-semibold">{t('migrate.export.done')}</h3>
          {done.masters ? (
            <p className="text-sm">
              {t('migrate.export.mastersDone', {
                ledgers: done.masters.counts.ledgers,
                items: done.masters.counts.stockItems,
              })}
            </p>
          ) : null}
          {done.vouchers ? (
            <p className="text-sm">
              {t('migrate.export.vouchersDone', { count: done.vouchers.counts.vouchers })}
            </p>
          ) : null}
          {[...(done.masters?.warnings ?? []), ...(done.vouchers?.warnings ?? [])].length > 0 ? (
            <ul className="text-sm text-fg-muted" aria-label={t('migrate.export.warnings')}>
              {[...(done.masters?.warnings ?? []), ...(done.vouchers?.warnings ?? [])].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-sm text-fg-muted">{t('migrate.export.steps')}</p>
        </Card>
      ) : null}
    </div>
  );
}
