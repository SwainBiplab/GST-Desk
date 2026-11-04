import {
  NumberingRepo,
  PeriodLockRepo,
  type LockInfo,
  type SeriesView,
  type ShellName,
} from '@gst/db';
import {
  DOCUMENT_TYPES,
  previewSeries,
  today,
  validateSeries,
  type SeriesSettings,
} from '@gst/domain';
import {
  Badge,
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb, useLiveQuery } from '@/app/db';
import { Field } from '@/features/onboarding/field';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Numbering: number series per document type, and the period lock. */
export function NumberingTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [editing, setEditing] = useState<SeriesView | 'new' | null>(null);
  const { data } = useLiveQuery<SeriesView[]>({
    tables: ['number_series', 'documents'],
    key: ['series-all'],
    fn: (d, c) => new NumberingRepo(d).listSeries(c),
  });
  const series = data ?? [];
  const byType = DOCUMENT_TYPES.map((type) => ({
    type,
    list: series.filter((s) => s.documentType === type),
  })).filter((g) => g.list.length > 0);

  const remove = async (s: SeriesView) => {
    if (!database || !ctx) return;
    try {
      await new NumberingRepo(database).removeSeries(ctx, s.key);
      toast.success(t('numbering.series.removed'));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="numbering-tab">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{t('numbering.series.title')}</h2>
          <Button className="ml-auto" data-testid="series-add" onClick={() => setEditing('new')}>
            {t('numbering.series.add')}
          </Button>
        </div>
        <p className="text-sm text-fg-muted">{t('numbering.series.help')}</p>
        {byType.length === 0 && (
          <p className="text-sm text-fg-muted" data-testid="series-empty">
            {t('numbering.series.empty')}
          </p>
        )}
        {byType.map(({ type, list }) => (
          <Card key={type} className="p-3">
            <CardTitle className="pb-2 text-base">{t(`docs.types.${type}`)}</CardTitle>
            <ul className="flex flex-col divide-y divide-border">
              {list.map((s) => (
                <li
                  key={s.key}
                  className="flex flex-wrap items-center gap-2 py-2"
                  data-testid="series-row"
                  data-type={type}
                  data-name={s.name}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span data-testid="series-name">{s.name}</span>
                      {s.isDefault && <Badge>{t('numbering.series.defaultBadge')}</Badge>}
                      {s.shellDefault && (
                        <Badge tone="info">
                          {t(
                            s.shellDefault === 'shop'
                              ? 'numbering.series.shellShop'
                              : 'numbering.series.shellBooks',
                          )}
                        </Badge>
                      )}
                    </p>
                    <p className="text-sm text-fg-muted">
                      <span className="font-mono" data-testid="series-format">
                        {s.prefix}
                        {'0'.repeat(s.padding)}
                        {s.suffix}
                      </span>{' '}
                      ·{' '}
                      {s.reset === 'fy'
                        ? t('numbering.series.resetFy')
                        : t('numbering.series.resetNever')}
                    </p>
                    <NextNumber series={s} />
                  </div>
                  <Button variant="outline" data-testid="series-edit" onClick={() => setEditing(s)}>
                    {t('numbering.series.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid="series-remove"
                    disabled={s.used || list.length === 1}
                    title={s.used ? t('numbering.series.removeUnused') : undefined}
                    onClick={() => void remove(s)}
                  >
                    {t('numbering.series.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </section>

      <PeriodLockPanel />

      {editing && (
        <SeriesDialog
          series={editing === 'new' ? null : editing}
          existing={series}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function NextNumber({ series }: { series: SeriesView }) {
  const { t } = useTranslation();
  const spec: SeriesSettings = {
    name: series.name,
    prefix: series.prefix,
    suffix: series.suffix,
    padding: series.padding,
    reset: series.reset,
    start: series.start,
  };
  const day = today(() => new Date());
  // the counter for the current year, or the first number a fresh one will use
  const label = series.counters.find((c) => c.fy !== null)
    ? series.counters[series.counters.length - 1]!
    : series.counters[0];
  const next = previewSeries(spec, label?.next ?? series.start, day);
  return (
    <p className="text-xs text-fg-muted">
      {t('numbering.series.next')}:{' '}
      <span className="font-mono" data-testid="series-next">
        {next ?? '—'}
      </span>
    </p>
  );
}

function SeriesDialog({
  series,
  existing,
  onClose,
}: {
  series: SeriesView | null;
  existing: SeriesView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [type, setType] = useState<string>(series?.documentType ?? 'tax_invoice');
  const [name, setName] = useState(series?.name ?? '');
  const [prefix, setPrefix] = useState(series?.prefix ?? '');
  const [suffix, setSuffix] = useState(series?.suffix ?? '');
  const [padding, setPadding] = useState(String(series?.padding ?? 4));
  const [start, setStart] = useState(String(series?.start ?? 1));
  const [reset, setReset] = useState<'fy' | 'never'>(series?.reset ?? 'fy');
  const [isDefault, setIsDefault] = useState(series?.isDefault ?? false);
  const [shell, setShell] = useState<ShellName | 'none'>(series?.shellDefault ?? 'none');
  const [busy, setBusy] = useState(false);

  const spec: SeriesSettings = {
    name,
    prefix,
    suffix,
    padding: Number(padding),
    reset,
    start: Number(start),
  };
  const problems = validateSeries(spec);
  const clash = existing.find(
    (s) =>
      s.documentType === type &&
      s.key !== series?.key &&
      s.prefix === prefix &&
      s.suffix === suffix,
  );
  const sameName = existing.find(
    (s) => s.documentType === type && s.key !== series?.key && s.name === name.trim(),
  );
  const messages = [
    ...problems.map((p) => p.message),
    ...(clash ? [`"${clash.name}" already uses this prefix and suffix.`] : []),
    ...(sameName ? [`A series named "${sameName.name}" already exists for this type.`] : []),
  ];
  const preview =
    messages.length === 0
      ? previewSeries(
          spec,
          series?.counters[series.counters.length - 1]?.next ?? spec.start,
          today(() => new Date()),
        )
      : null;

  const save = async () => {
    if (!database || !ctx || messages.length > 0) return;
    setBusy(true);
    try {
      const repo = new NumberingRepo(database);
      const common = {
        name: name.trim(),
        prefix,
        suffix,
        padding: Number(padding),
        reset,
        start: Number(start),
        isDefault,
        shellDefault: shell === 'none' ? null : shell,
      };
      if (series) await repo.updateSeries(ctx, series.key, common);
      else await repo.createSeries(ctx, { documentType: type, ...common });
      toast.success(t('numbering.series.saved'));
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="series-dialog" className="max-h-[90vh] overflow-auto">
        <DialogTitle className="text-lg font-semibold">
          {series ? t('numbering.series.edit') : t('numbering.series.add')}
        </DialogTitle>
        <DialogDescription className="text-sm text-fg-muted">
          {series ? t('numbering.series.renameNote') : t('numbering.series.tokens')}
        </DialogDescription>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('numbering.series.type')}>
            {(c) => (
              <Select value={type} onValueChange={setType} disabled={!!series}>
                <SelectTrigger {...c} data-testid="series-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((x) => (
                    <SelectItem key={x} value={x}>
                      {t(`docs.types.${x}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t('numbering.series.name')}>
            {(c) => (
              <Input
                {...c}
                data-testid="series-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('numbering.series.prefix')}>
            {(c) => (
              <Input
                {...c}
                data-testid="series-prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('numbering.series.suffix')}>
            {(c) => (
              <Input
                {...c}
                data-testid="series-suffix"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('numbering.series.padding')}>
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                data-testid="series-padding"
                value={padding}
                onChange={(e) => setPadding(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('numbering.series.start')}>
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                data-testid="series-start"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('numbering.series.reset')}>
            {(c) => (
              <Select value={reset} onValueChange={(v) => setReset(v as 'fy' | 'never')}>
                <SelectTrigger {...c} data-testid="series-reset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fy">{t('numbering.series.resetFy')}</SelectItem>
                  <SelectItem value="never">{t('numbering.series.resetNever')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t('numbering.series.shell')}>
            {(c) => (
              <Select value={shell} onValueChange={(v) => setShell(v as ShellName | 'none')}>
                <SelectTrigger {...c} data-testid="series-shell">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('numbering.series.shellNone')}</SelectItem>
                  <SelectItem value="books">{t('numbering.series.shellBooks')}</SelectItem>
                  <SelectItem value="shop">{t('numbering.series.shellShop')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isDefault}
            data-testid="series-default"
            onCheckedChange={(v) => setIsDefault(v === true)}
          />
          {t('numbering.series.isDefault')}
        </label>
        {messages.length > 0 && (
          <ul role="alert" className="text-sm text-danger" data-testid="series-problems">
            {messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <p className="text-sm" aria-live="polite">
          {t('numbering.series.preview')}:{' '}
          <span className="font-mono font-semibold" data-testid="series-preview">
            {preview ?? t('numbering.series.previewNone')}
          </span>
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('lock.cancel')}
          </Button>
          <Button
            data-testid="series-save"
            disabled={busy || messages.length > 0}
            onClick={() => void save()}
          >
            {t('numbering.series.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PeriodLockPanel() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const { data: lock } = useLiveQuery<LockInfo | null>({
    tables: ['settings'],
    key: ['period-lock'],
    fn: (d, c) => new PeriodLockRepo(d).get(c),
  });
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const date = until || lock?.until || '';

  const apply = async (to: string | null) => {
    if (!database || !ctx) return;
    try {
      await new PeriodLockRepo(database).set(ctx, to, reason);
      toast.success(to ? t('numbering.lock.saved') : t('numbering.lock.unlocked'));
      setReason('');
      setUntil('');
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <section className="flex flex-col gap-3" data-testid="period-lock">
      <h2 className="text-lg font-semibold">{t('numbering.lock.title')}</h2>
      <p className="text-sm text-fg-muted">{t('numbering.lock.help')}</p>
      <p className="text-sm font-medium" data-testid="lock-state">
        {lock ? t('numbering.lock.locked', { until: lock.until }) : t('numbering.lock.none')}
      </p>
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label={t('numbering.lock.until')}>
          {(c) => (
            <Input
              {...c}
              type="date"
              data-testid="lock-until"
              value={date}
              onChange={(e) => setUntil(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('numbering.lock.reason')}>
          {(c) => (
            <Input
              {...c}
              data-testid="lock-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button data-testid="lock-set" disabled={!date} onClick={() => void apply(date)}>
          {t('numbering.lock.set')}
        </Button>
        {lock && (
          <Button variant="outline" data-testid="lock-clear" onClick={() => void apply(null)}>
            {t('numbering.lock.unlock')}
          </Button>
        )}
      </div>
    </section>
  );
}
