import type { ReconRow } from '@gst/db';
import {
  parseAmountPaise,
  parseRateBp,
  type GstrPeriod,
  type MatchClass,
  type ReconOptions,
} from '@gst/domain';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  toast,
} from '@gst/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useReconActions, useReconOptions, useWorkspace } from './recon-hooks';
import {
  CLASS_FILTERS,
  acceptableCount,
  actionsFor,
  countByClass,
  filterRows,
  linkableBills,
  tiles,
  type ClassFilter,
  type RowAction,
} from './recon-model';

import { useAppNavigate } from '@/app/hooks';
import { ExplainButton } from '@/features/ai/explain';
import { dyn } from '@/lib/dyn-key';

const TONE: Record<MatchClass, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
  matched: 'success',
  matched_with_differences: 'warning',
  in_2b_not_in_books: 'info',
  in_books_not_in_2b: 'warning',
  duplicate_in_books: 'danger',
};

const PAGE = 100;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `MMYYYY` as a label in the person's language. */
function monthLabel(fp: string, locale: string): string {
  const d = new Date(Date.UTC(Number(fp.slice(2)), Number(fp.slice(0, 2)) - 1, 1));
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** Import a GSTR-2B and match it with the purchase bills; decide each result; apply the outcome to GSTR-3B. */
export function ReconcileTab({ period }: { period: GstrPeriod }) {
  const { t, i18n } = useTranslation();
  const ws = useWorkspace(period);
  const act = useReconActions(period);
  const navigate = useAppNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [month, setMonth] = useState(period.fp);
  const [cls, setCls] = useState<ClassFilter>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<ReconRow | null>(null);

  const data = ws.data;
  const rows = data?.rows ?? [];
  const shown = filterRows(rows, { cls, q });
  const counts = countByClass(rows);
  const last = data?.imports.find((i) => i.period === period.fp) ?? null;

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void guard(async () => {
      const r = await act.importFile(file, month);
      toast.success(
        t('gst.recon.imported', { count: r.count, period: monthLabel(r.period, i18n.language) }),
      );
      if (r.problems.length > 0)
        toast.warning(t('gst.recon.skipped', { count: r.problems.length }));
      if (r.reverseChargeLeftOut > 0)
        toast.info(t('gst.recon.rcmLeftOut', { count: r.reverseChargeLeftOut }));
    });
    if (fileInput.current) fileInput.current.value = '';
  };

  const run = (r: ReconRow, action: RowAction) =>
    guard(async () => {
      if (action === 'accept') await act.decide(r, 'accept');
      else if (action === 'toFile') await act.decide(r, 'supplier_to_file');
      else if (action === 'ignore') await act.decide(r, 'ignore');
      else if (action === 'undo') await act.clear(r);
      else if (action === 'link') setLinking(r);
      else if (action === 'createBill') {
        const made = await act.prepareBill(r);
        if (made.added) toast.success(t('gst.recon.supplierAdded', { name: made.name }));
        navigate('/books/documents/new', { type: 'purchase_bill' });
      }
    });

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby={`recon-${period.fp}`} className="flex flex-col gap-2">
        <h3 id={`recon-${period.fp}`} className="text-base font-semibold">
          {t('gst.recon.title')}
        </h3>
        <p className="text-sm text-fg-muted">{t('gst.recon.intro')}</p>
        <p role="note" className="text-sm text-fg-muted">
          {t('gst.recon.beta')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".json,.xlsx,application/json"
            className="sr-only"
            data-testid="recon-file"
            aria-label={t('gst.recon.import')}
            tabIndex={-1}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? t('gst.recon.reading') : t('gst.recon.import')}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            {t('gst.recon.month')}
            <Input
              className="w-28"
              value={month}
              inputMode="numeric"
              aria-label={t('gst.recon.month')}
              onChange={(e) => setMonth(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <span className="text-sm text-fg-muted">
            {last
              ? t('gst.recon.last', {
                  count: last.entryCount,
                  date: new Date(last.importedAt).toISOString().slice(0, 10),
                })
              : t('gst.recon.none')}
          </span>
        </div>
      </section>

      <Tolerances period={period} />

      {data ? (
        <>
          <ul
            className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6"
            aria-label={t('gst.recon.title')}
          >
            {tiles(data.summary).map((x) => (
              <li
                key={x.key}
                className="rounded-md border border-border p-3"
                data-testid={`tile-${x.key}`}
              >
                <div className="text-xs text-fg-muted">{t(dyn(`gst.recon.tiles.${x.key}`))}</div>
                <div className="text-lg font-semibold">
                  <MoneyText paise={x.paise} negativeRed />
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              {t('gst.recon.filter')}
              <Select
                value={cls}
                onValueChange={(v) => {
                  setCls(v as ClassFilter);
                  setLimit(PAGE);
                }}
              >
                <SelectTrigger
                  className="w-64"
                  aria-label={t('gst.recon.filter')}
                  data-testid="recon-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASS_FILTERS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(dyn(`gst.recon.cls.${c}`))} ({counts[c]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex min-w-60 flex-col gap-1 text-sm">
              {t('gst.recon.search')}
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setLimit(PAGE);
                }}
              />
            </label>
            <Button
              variant="secondary"
              disabled={busy || acceptableCount(rows) === 0}
              onClick={() =>
                void guard(async () => {
                  const n = await act.acceptAll();
                  toast.success(t('gst.recon.act.acceptedAll', { count: n }));
                })
              }
            >
              {t('gst.recon.act.acceptAll')} ({acceptableCount(rows)})
            </Button>
            <Button
              disabled={busy || !data.hasImport}
              onClick={() =>
                void guard(async () => {
                  const list = await act.apply();
                  if (list.length === 0) toast.success(t('gst.recon.act.appliedNone'));
                  else toast.success(t('gst.recon.act.applied', { count: list.length }));
                })
              }
            >
              {t('gst.recon.act.apply')}
            </Button>
          </div>
          <p className="text-sm text-fg-muted">{t('gst.recon.applyHint')}</p>

          {shown.length === 0 ? (
            <p>{t('gst.recon.nothing')}</p>
          ) : (
            <>
              <Table data-testid="recon-table">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t('gst.recon.col.class')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.supplier')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.in2b')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.inBooks')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.why')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.decision')}</TableHeaderCell>
                    <TableHeaderCell>{t('gst.recon.col.actions')}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.slice(0, limit).map((r) => (
                    <Row key={r.key} row={r} busy={busy} onAction={(a) => void run(r, a)} />
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center gap-3 text-sm text-fg-muted">
                <span>
                  {t('gst.recon.showing', {
                    shown: Math.min(limit, shown.length),
                    total: shown.length,
                  })}
                </span>
                {shown.length > limit ? (
                  <Button variant="secondary" onClick={() => setLimit(limit + PAGE)}>
                    {t('gst.recon.more')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}

      {linking ? (
        <LinkDialog
          row={linking}
          candidates={linkableBills(rows)}
          onClose={() => setLinking(null)}
          onSave={(billId, note) =>
            guard(async () => {
              await act.decide(linking, 'link', { linkedDocumentId: billId, note });
              setLinking(null);
              toast.success(t('gst.recon.act.saved'));
            })
          }
        />
      ) : null}
    </div>
  );
}

function amounts(x: { taxable: number; igst: number; cgst: number; sgst: number; cess: number }) {
  return x.taxable + x.igst + x.cgst + x.sgst + x.cess;
}

function Row({
  row,
  busy,
  onAction,
}: {
  row: ReconRow;
  busy: boolean;
  onAction: (a: RowAction) => void;
}) {
  const { t } = useTranslation();
  const e = row.entry;
  const b = row.bill;
  const x = row.explanation;
  const fields =
    typeof x.params['fields'] === 'string' && x.params['fields']
      ? String(x.params['fields'])
          .split(',')
          .map((f) => t(dyn(`gst.recon.fields.${f}`)))
          .join(', ')
      : '';
  const actions = actionsFor(row);
  return (
    <TableRow data-testid="recon-row" data-class={row.match.cls}>
      <TableCell>
        <Badge tone={TONE[row.match.cls]}>{t(dyn(`gst.recon.cls.${row.match.cls}`))}</Badge>
        {row.carried ? (
          <div className="mt-1 text-xs text-fg-muted">{t('gst.recon.carried')}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="font-medium">{e?.supplierName || ''}</div>
        <div className="text-xs text-fg-muted">{e?.supplierGstin ?? b?.supplierGstin}</div>
      </TableCell>
      <TableCell>
        {e ? (
          <>
            <div>{e.number}</div>
            <div className="text-xs text-fg-muted">
              {e.date} ·{' '}
              <MoneyText paise={amounts(e) * (e.docType === 'credit_note' ? -1 : 1)} negativeRed />
            </div>
          </>
        ) : null}
      </TableCell>
      <TableCell>
        {b ? (
          <>
            <div>{b.number}</div>
            <div className="text-xs text-fg-muted">
              {b.date} ·{' '}
              <MoneyText paise={amounts(b) * (b.type === 'purchase_return' ? -1 : 1)} negativeRed />
            </div>
          </>
        ) : null}
      </TableCell>
      <TableCell className="max-w-72 text-sm">
        {t(dyn(`gst.recon.explain.${x.key}`), { ...x.params, fields })}
      </TableCell>
      <TableCell>
        {row.decision ? (
          <>
            <Badge tone="neutral">{t(dyn(`gst.recon.decision.${row.decision.decision}`))}</Badge>
            {row.decision.note ? (
              <div className="mt-1 text-xs text-fg-muted">{row.decision.note}</div>
            ) : null}
          </>
        ) : null}
      </TableCell>
      <TableCell>
        {row.match.cls !== 'matched' && <ExplainButton row={row} />}
        {actions.length > 0 ? (
          <div className="flex items-center gap-1">
            <Button variant="secondary" disabled={busy} onClick={() => onAction(actions[0]!)}>
              {t(dyn(`gst.recon.act.${actions[0] === 'toFile' ? 'toFile' : actions[0]}`))}
            </Button>
            {actions.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" aria-label={t('gst.recon.act.menu')}>
                    …
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {actions.slice(1).map((a) => (
                    <DropdownMenuItem key={a} onSelect={() => onAction(a)}>
                      {t(dyn(`gst.recon.act.${a}`))}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function LinkDialog({
  row,
  candidates,
  onClose,
  onSave,
}: {
  row: ReconRow;
  candidates: ReconRow[];
  onClose: () => void;
  onSave: (billId: string, note: string) => void;
}) {
  const { t } = useTranslation();
  const [billId, setBillId] = useState('');
  const [note, setNote] = useState('');
  const mine = candidates.filter(
    (c) => (c.bill?.supplierGstin ?? '') === (row.entry?.supplierGstin ?? ''),
  );
  const list = mine.length > 0 ? mine : candidates;
  return (
    <AlertDialog open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogTitle>
          {t('gst.recon.link.title', { number: row.entry?.number ?? '' })}
        </AlertDialogTitle>
        <AlertDialogDescription className="sr-only">
          {t('gst.recon.link.title', { number: row.entry?.number ?? '' })}
        </AlertDialogDescription>
        {list.length === 0 ? (
          <p>{t('gst.recon.link.none')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              {t('gst.recon.link.pick')}
              <Select value={billId} onValueChange={setBillId}>
                <SelectTrigger aria-label={t('gst.recon.link.pick')} data-testid="link-pick">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((c) => (
                    <SelectItem key={c.bill!.id} value={c.bill!.id}>
                      {c.bill!.supplierGstin} · {c.bill!.number} · {c.bill!.date}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('gst.recon.link.note')}
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('gst.file.cancel')}
          </Button>
          <Button disabled={!billId} onClick={() => onSave(billId, note)}>
            {t('gst.recon.link.save')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The matching tolerances, kept as the business's own settings. */
function Tolerances({ period }: { period: GstrPeriod }) {
  const { t } = useTranslation();
  const opts = useReconOptions().data;
  const act = useReconActions(period);
  const [draft, setDraft] = useState<{
    exact: string;
    widest: string;
    rupees: string;
    percent: string;
  } | null>(null);
  if (!opts) return null;
  const shown = draft ?? {
    exact: String(opts.exactDateDays),
    widest: String(opts.fuzzyDateDays),
    rupees: (opts.amountTolerancePaise / 100).toFixed(2),
    percent: (opts.amountToleranceBp / 100).toFixed(2),
  };
  const save = async () => {
    const exact = /^\d+$/.test(shown.exact) ? Number(shown.exact) : null;
    const widest = /^\d+$/.test(shown.widest) ? Number(shown.widest) : null;
    const paise = parseAmountPaise(shown.rupees);
    const bp = parseRateBp(shown.percent);
    if (
      exact === null ||
      widest === null ||
      paise === undefined ||
      paise === null ||
      bp === undefined ||
      bp === null
    ) {
      toast.error(t('gst.recon.tol.bad'));
      return;
    }
    const next: ReconOptions = {
      exactDateDays: exact,
      fuzzyDateDays: widest,
      amountTolerancePaise: Number(paise),
      amountToleranceBp: Number(bp),
    };
    try {
      await act.saveOptions(next);
      setDraft(null);
      toast.success(t('gst.recon.tol.saved'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const field = (key: keyof typeof shown, label: string) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input
        className="w-36 text-right"
        inputMode="decimal"
        value={shown[key]}
        onChange={(e) => setDraft({ ...shown, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t('gst.recon.tol.title')}</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-fg-muted">{t('gst.recon.tol.hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          {field('exact', t('gst.recon.tol.exact'))}
          {field('widest', t('gst.recon.tol.widest'))}
          {field('rupees', t('gst.recon.tol.rupees'))}
          {field('percent', t('gst.recon.tol.percent'))}
          <Button onClick={() => void save()}>{t('gst.recon.tol.save')}</Button>
        </div>
      </div>
    </details>
  );
}
