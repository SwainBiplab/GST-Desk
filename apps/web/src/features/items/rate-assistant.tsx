import { ConflictError, ItemRepo, type BulkBatch, type RateChangeRow } from '@gst/db';
import type { BulkPlanEntry } from '@gst/domain';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { trimZeros } from './form';
import { useRateChanges } from './hooks';

import { useAppDb } from '@/app/db';

const pct = (bp: number) => `${trimZeros((bp / 100).toFixed(2))}%`;
const dmy = (iso: string) => iso.split('-').reverse().join('/');

/**
 * When a new version of the HSN master changes a rate, list the items that follow the master and
 * offer to update them. A change that starts in the future is shown but cannot be applied yet, so a
 * new rate never reaches an invoice before its effective date. Items with a deliberate override
 * are left out. The update can be undone.
 */
export function RateAssistant({
  onApplied,
}: {
  onApplied: (batch: BulkBatch, count: number) => void;
}) {
  const { t } = useTranslation();
  const { data } = useRateChanges();
  const [open, setOpen] = useState(false);
  const rows = data ?? [];
  if (rows.length === 0) return null;
  const due = rows.filter((r) => r.due).length;

  return (
    <>
      <Card className="flex flex-wrap items-center gap-3 p-3" data-testid="rate-assistant-card">
        <p className="flex-1 text-sm">{t('items.rates.banner', { count: rows.length })}</p>
        <Button variant="outline" data-testid="rate-assistant-open" onClick={() => setOpen(true)}>
          {t('items.rates.review', { due })}
        </Button>
      </Card>
      {open && <RateDialog rows={rows} onClose={() => setOpen(false)} onApplied={onApplied} />}
    </>
  );
}

function RateDialog({
  rows,
  onClose,
  onApplied,
}: {
  rows: RateChangeRow[];
  onClose: () => void;
  onApplied: (batch: BulkBatch, count: number) => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [chosen, setChosen] = useState(() => new Set(rows.filter((r) => r.due).map((r) => r.id)));
  const [busy, setBusy] = useState(false);
  const dueRows = rows.filter((r) => r.due);

  const apply = async () => {
    if (!database || !ctx) return;
    const picked = rows.filter((r) => r.due && chosen.has(r.id));
    if (picked.length === 0) return;
    const plan: BulkPlanEntry[] = picked.map((r) => ({
      id: r.id,
      version: r.version,
      name: r.name,
      before: { gst_rate_bp: r.oldRateBp, cess_bp: r.oldCessBp },
      after: { gst_rate_bp: r.newRateBp, cess_bp: r.newCessBp },
    }));
    setBusy(true);
    try {
      const batch = await new ItemRepo(database).applyBulkEdit(ctx, plan);
      onApplied(batch, batch.entries.length);
      onClose();
    } catch (e) {
      toast.error(
        e instanceof ConflictError
          ? t('items.bulk.conflict')
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(52rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden"
        data-testid="rate-dialog"
      >
        <DialogTitle className="text-lg font-semibold">{t('items.rates.title')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{t('items.rates.help')}</DialogDescription>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm" aria-label={t('items.rates.title')}>
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="w-10 p-2">
                  <Checkbox
                    aria-label={t('items.list.selectAll')}
                    checked={dueRows.length > 0 && dueRows.every((r) => chosen.has(r.id))}
                    onCheckedChange={(v) =>
                      setChosen(v === true ? new Set(dueRows.map((r) => r.id)) : new Set())
                    }
                  />
                </th>
                <th className="p-2">{t('items.cols.name')}</th>
                <th className="p-2">{t('items.cols.hsn')}</th>
                <th className="p-2">{t('items.rates.change')}</th>
                <th className="p-2">{t('items.rates.effective')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border" data-testid="rate-row">
                  <td className="p-2">
                    <Checkbox
                      aria-label={r.name}
                      disabled={!r.due}
                      checked={r.due && chosen.has(r.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(chosen);
                        if (v === true) next.add(r.id);
                        else next.delete(r.id);
                        setChosen(next);
                      }}
                    />
                  </td>
                  <td className="p-2">{r.name}</td>
                  <td className="p-2 tabular-nums">{r.hsn}</td>
                  <td className="p-2 tabular-nums">
                    {pct(r.oldRateBp)} → <strong>{pct(r.newRateBp)}</strong>
                  </td>
                  <td className="p-2">
                    {r.due
                      ? dmy(r.effectiveFrom)
                      : t('items.rates.from', { date: dmy(r.effectiveFrom) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('items.form.cancel')}
          </Button>
          <Button
            data-testid="rate-apply"
            disabled={busy || chosen.size === 0}
            onClick={() => void apply()}
          >
            {t('items.rates.apply', { count: chosen.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
