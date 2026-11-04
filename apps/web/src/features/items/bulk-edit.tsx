import { ConflictError, ItemRepo, type BulkBatch, type Row } from '@gst/db';
import {
  GST_RATES_BP,
  changed,
  parseAmountPaise,
  parseScaledStrict,
  planBulkEdit,
  toDecimalString,
  type BulkChange,
  type BulkItem,
  type PriceField,
} from '@gst/domain';
import {
  Button,
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
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { trimZeros } from './form';

import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';

type What = 'gst_rate' | PriceField | 'tag_add' | 'tag_remove';
const WHATS: What[] = [
  'gst_rate',
  'sale_rate_paise',
  'purchase_rate_paise',
  'mrp_paise',
  'tag_add',
  'tag_remove',
];
const SHOWN = 50;

const isPrice = (w: What): w is PriceField => w.endsWith('_paise');
const rateText = (bp: number) => trimZeros((bp / 100).toFixed(2));

function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (key.endsWith('_paise')) return toDecimalString(BigInt(v as number));
  if (key.endsWith('_bp')) return `${rateText(v as number)}%`;
  if (Array.isArray(v)) return v.join(', ') || '-';
  return String(v);
}

/**
 * Change the GST rate, a price (by percent or an amount) or a tag on every selected item. Shows
 * exactly what each item becomes before anything is written; the result can be undone.
 */
export function BulkEditDialog({
  items,
  onClose,
  onApplied,
}: {
  items: Row[];
  onClose: () => void;
  onApplied: (batch: BulkBatch, count: number) => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [what, setWhat] = useState<What>('gst_rate');
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [rate, setRate] = useState('1800');
  const [busy, setBusy] = useState(false);

  const change = useMemo<BulkChange | null>(() => {
    if (what === 'gst_rate') return { kind: 'gst_rate', rateBp: Number(rate) };
    if (what === 'tag_add' || what === 'tag_remove')
      return value.trim()
        ? { kind: 'tag', op: what === 'tag_add' ? 'add' : 'remove', tag: value }
        : null;
    if (mode === 'percent') {
      const pct = parseScaledStrict(value.replace('%', ''), 2, { allowNegative: true });
      return typeof pct === 'number' ? { kind: 'price', field: what, mode, percentBp: pct } : null;
    }
    const amt = parseAmountPaise(value, { allowNegative: true });
    return typeof amt === 'number' ? { kind: 'price', field: what, mode, deltaPaise: amt } : null;
  }, [what, mode, value, rate]);

  const plan = useMemo(
    () => (change ? planBulkEdit(items as unknown as BulkItem[], change) : []),
    [items, change],
  );
  const toChange = changed(plan);
  const skipped = plan.length - toChange.length;

  const apply = async () => {
    if (!database || !ctx || toChange.length === 0) return;
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

  const valueLabel =
    what === 'tag_add' || what === 'tag_remove'
      ? t('items.bulk.tag')
      : mode === 'percent'
        ? t('items.bulk.percent')
        : t('items.bulk.amount');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(52rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden"
        data-testid="bulk-dialog"
      >
        <DialogTitle className="text-lg font-semibold">
          {t('items.bulk.title', { count: items.length })}
        </DialogTitle>
        <DialogDescription className="text-fg-muted">{t('items.bulk.help')}</DialogDescription>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('items.bulk.what')}>
            {(c) => (
              <Select value={what} onValueChange={(v) => setWhat(v as What)}>
                <SelectTrigger {...c} data-testid="bulk-what">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHATS.map((w) => (
                    <SelectItem key={w} value={w}>
                      {t(`items.bulk.whats.${w}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {what === 'gst_rate' ? (
            <Field label={t('items.form.gstRate')}>
              {(c) => (
                <Select value={rate} onValueChange={setRate}>
                  <SelectTrigger {...c} data-testid="bulk-rate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GST_RATES_BP.map((bp) => (
                      <SelectItem key={bp} value={String(bp)}>
                        {rateText(bp)}%
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          ) : (
            <>
              {isPrice(what) && (
                <Field label={t('items.bulk.mode')}>
                  {(c) => (
                    <Select value={mode} onValueChange={(v) => setMode(v as 'percent' | 'amount')}>
                      <SelectTrigger {...c} data-testid="bulk-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percent">{t('items.bulk.byPercent')}</SelectItem>
                        <SelectItem value="amount">{t('items.bulk.byAmount')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              )}
              <Field label={valueLabel} hint={isPrice(what) ? t('items.bulk.signHelp') : undefined}>
                {(c) => (
                  <Input
                    {...c}
                    data-testid="bulk-value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
        </div>

        <p className="text-sm font-medium" data-testid="bulk-summary" aria-live="polite">
          {change
            ? t('items.bulk.summary', { changing: toChange.length, skipped })
            : t('items.bulk.enter')}
        </p>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm" aria-label={t('items.bulk.preview')}>
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="p-2">{t('items.cols.name')}</th>
                <th className="p-2">{t('items.bulk.before')}</th>
                <th className="p-2">{t('items.bulk.after')}</th>
              </tr>
            </thead>
            <tbody>
              {plan.slice(0, SHOWN).map((p) => {
                const key = Object.keys(p.after)[0];
                return (
                  <tr key={p.id} className="border-t border-border" data-testid="bulk-row">
                    <td className="p-2">{p.name}</td>
                    {p.skipped || !key ? (
                      <td className="p-2 text-fg-muted" colSpan={2}>
                        {t(`items.bulk.skip.${p.skipped ?? 'unchanged'}`)}
                      </td>
                    ) : (
                      <>
                        <td className="p-2 tabular-nums">{show(key, p.before[key])}</td>
                        <td className="p-2 tabular-nums font-medium">{show(key, p.after[key])}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {plan.length > SHOWN && (
          <p className="text-xs text-fg-muted">
            {t('items.bulk.more', { count: plan.length - SHOWN })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('items.form.cancel')}
          </Button>
          <Button
            data-testid="bulk-apply"
            disabled={busy || toChange.length === 0}
            onClick={() => void apply()}
          >
            {t('items.bulk.apply', { count: toChange.length })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
