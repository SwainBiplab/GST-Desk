import { PartyRepo, REPORTS, type ReportDef, type ReportRow } from '@gst/db';
import { PERIOD_PRESETS, resolvePeriod, type PeriodPreset } from '@gst/domain';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { CSV_MIME, XLSX_MIME, downloadBytes, fileSafe } from './download';
import { PAGE_ROWS, todayIso, useReportData, useReportExport, useSavedViews } from './hooks';
import {
  defaultColumns,
  exportColumns,
  isNumericKind,
  layoutLines,
  showCell,
  toCsvText,
  toSheet,
  writeReportState,
  type ExportInput,
  type ReportState,
  type Translate,
} from './model';
import { toXlsx } from './xlsx';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { editorPath } from '@/features/documents/editor-page';

const ROW_HEIGHT = 32;
/** The most rows printed on paper; a longer register is exported instead. */
const PRINT_CAP = 3000;

const widthOf = (key: string, kind: string): string =>
  kind === 'money'
    ? '8.5rem'
    : key === 'party' || key === 'item' || key === 'category'
      ? 'minmax(12rem,2fr)'
      : kind === 'date'
        ? '6.5rem'
        : key === 'description'
          ? 'minmax(10rem,2fr)'
          : '8rem';

function PartyFilter({
  partyId,
  onChange,
}: {
  partyId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const chosen = useLiveQuery({
    tables: ['parties'],
    key: ['report-party', partyId],
    enabled: !!partyId,
    fn: (d, c) => new PartyRepo(d).get(c, partyId!),
  });
  const found = useLiveQuery({
    tables: ['parties'],
    key: ['report-party-search', q.trim()],
    enabled: q.trim().length > 0,
    fn: (d, c) => new PartyRepo(d).search(c, q.trim(), 6),
  });
  if (partyId) {
    return (
      <div
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
        data-testid="report-party-chip"
      >
        <span>{String(chosen.data?.['name'] ?? '…')}</span>
        <button
          type="button"
          aria-label={t('reports.clearParty')}
          className="px-1 text-fg-muted"
          onClick={() => onChange(null)}
        >
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input
        value={q}
        placeholder={t('reports.party')}
        aria-label={t('reports.party')}
        data-testid="report-party"
        onChange={(e) => setQ(e.target.value)}
        className="w-44"
      />
      {q.trim() && (found.data?.length ?? 0) > 0 && (
        <ul className="absolute z-20 mt-1 w-64 rounded-md border border-border bg-bg p-1 shadow-md">
          {found.data!.map((p) => (
            <li key={String(p['id'])}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-1"
                onClick={() => {
                  setQ('');
                  onChange(String(p['id']));
                }}
              >
                {String(p['name'])}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SaveViewPopover({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = async () => {
    if (!name.trim()) return;
    await onSave(name);
    setName('');
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" data-testid="report-save-view">
          {t('reports.saveView')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex flex-col gap-2">
          <Input
            value={name}
            placeholder={t('reports.viewName')}
            aria-label={t('reports.viewName')}
            data-testid="report-view-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          <Button
            data-testid="report-view-save"
            disabled={!name.trim()}
            onClick={() => void submit()}
          >
            {t('reports.save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One report: the filters, the table, the totals, and what can be done with them. */
export function ReportView({
  state,
  shell,
  title,
}: {
  state: ReportState;
  shell: Shell;
  title: string;
}) {
  const { t, i18n } = useTranslation();
  const tr = t as unknown as Translate;
  const navigate = useAppNavigate();
  const { business } = useAppDb();
  const def: ReportDef = REPORTS[state.id];
  const data = useReportData(state);
  const exporter = useReportExport();
  const views = useSavedViews();
  const [busy, setBusy] = useState<null | 'csv' | 'xlsx' | 'print'>(null);
  const [printRows, setPrintRows] = useState<ReportRow[] | null>(null);
  const day = todayIso();
  const fyStart = Number(business?.['fy_start_month'] ?? 4);

  const shown = state.cols ?? defaultColumns(def);
  const columns = useMemo(() => exportColumns(def, shown), [def, shown]);
  const header = (c: { key: string }) =>
    t([`reports.col.${state.id}.${c.key}`, `reports.col.${c.key}`], { defaultValue: c.key });

  const go = (patch: Partial<ReportState>) =>
    navigate(`/${shell}/reports`, writeReportState({ ...state, ...patch }));

  // grouping works on the rows in hand, so a grouped register loads everything first
  const grouped = !!state.group;
  const { loadAll, hasMore } = data;
  useEffect(() => {
    if (grouped && hasMore) void loadAll(50_000);
  }, [grouped, hasMore, loadAll]);

  const lines = useMemo(
    () => layoutLines(state.id, def.columns, data.rows, state.group, tr),
    [state.id, def.columns, data.rows, state.group, tr],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  // near the bottom of a register, bring the next page in
  const items = virt.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : -1;
  const { fetchMore, isFetchingMore } = data;
  useEffect(() => {
    if (!grouped && hasMore && !isFetchingMore && lastIndex >= lines.length - 20) fetchMore();
  }, [grouped, hasMore, isFetchingMore, lastIndex, lines.length, fetchMore]);

  const template = columns.map((c) => widthOf(c.key, c.kind)).join(' ');
  const exportInput = (rows: ReportRow[], totals: Record<string, number>): ExportInput => ({
    id: state.id,
    columns,
    rows,
    totals,
    title,
    totalLabel: t('reports.total'),
    header,
    t: tr,
  });
  const fileBase = `${fileSafe(String(business?.['name'] ?? 'GST Desk'))}_${fileSafe(title)}_${state.from}_${state.to}`;

  const doExport = async (kind: 'csv' | 'xlsx') => {
    setBusy(kind);
    try {
      const { rows, totals } = await exporter(state);
      const x = exportInput(rows, totals);
      if (kind === 'csv') downloadBytes(`${fileBase}.csv`, toCsvText(x), CSV_MIME);
      else downloadBytes(`${fileBase}.xlsx`, toXlsx(toSheet(x)) as BlobPart, XLSX_MIME);
      toast.success(t('reports.exported', { count: rows.length }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPrint = async () => {
    setBusy('print');
    try {
      const rows = await data.loadAll(PRINT_CAP);
      if (data.count > rows.length)
        toast.info(t('reports.printCapped', { count: rows.length, total: data.count }));
      setPrintRows(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };
  // print once the sheet is on the page; clear it afterwards
  useEffect(() => {
    if (!printRows) return;
    const done = () => {
      setPrintRows(null);
      setBusy(null);
    };
    window.addEventListener('afterprint', done, { once: true });
    const id = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('afterprint', done);
    };
  }, [printRows]);

  const open = (row: ReportRow) => {
    if (!def.drill || !row['id']) return;
    if (def.drill === 'party') navigate(`/${shell}/parties`, { open: row['id'] });
    else {
      const type = String(row['type'] ?? row['kind'] ?? '');
      navigate(editorPath(shell), { type, id: row['id'] });
    }
  };

  const setPreset = (p: PeriodPreset) => {
    if (p === 'custom') return go({ preset: 'custom' });
    const r = resolvePeriod(p, day, fyStart);
    go({ preset: p, from: r.from, to: r.to });
  };

  const empty = !data.isLoading && data.rows.length === 0;
  const totalsKnown = columns.some((c) => c.total);

  return (
    <div
      data-testid="report-view"
      data-report={state.id}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="report-params">
        {def.filters.includes('period') && (
          <>
            <Select value={state.preset} onValueChange={(v) => setPreset(v as PeriodPreset)}>
              <SelectTrigger
                className="w-44"
                aria-label={t('reports.period')}
                data-testid="report-preset"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`reports.preset.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              className="w-40"
              value={state.from}
              aria-label={t('reports.from')}
              data-testid="report-from"
              onChange={(e) => e.target.value && go({ preset: 'custom', from: e.target.value })}
            />
            <Input
              type="date"
              className="w-40"
              value={state.to}
              aria-label={t('reports.to')}
              data-testid="report-to"
              onChange={(e) => e.target.value && go({ preset: 'custom', to: e.target.value })}
            />
          </>
        )}
        {def.filters.includes('asOf') && (
          <span className="text-sm text-fg-muted" data-testid="report-asof">
            {t('reports.asOf', { date: day })}
          </span>
        )}
        {def.filters.includes('party') && (
          <PartyFilter partyId={state.partyId} onChange={(id) => go({ partyId: id })} />
        )}
        {def.typeOptions && (
          <Select
            value={state.type ?? 'all'}
            onValueChange={(v) => go({ type: v === 'all' ? null : v })}
          >
            <SelectTrigger
              className="w-44"
              aria-label={t('reports.type')}
              data-testid="report-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {state.id !== 'gst_summary' && (
                <SelectItem value="all">{t('reports.allTypes')}</SelectItem>
              )}
              {def.typeOptions.map((o) => (
                <SelectItem key={o} value={o}>
                  {state.id === 'gst_summary'
                    ? t(`reports.side.${o}`)
                    : t(`docs.types.${o}`, { defaultValue: o })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {def.filters.includes('side') && (
          <Select value={state.side} onValueChange={(v) => go({ side: v as ReportState['side'] })}>
            <SelectTrigger
              className="w-44"
              aria-label={t('reports.sideLabel')}
              data-testid="report-side"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['receivable', 'payable', 'all'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`reports.sideOption.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {def.filters.includes('book') && (
          <Select value={state.book} onValueChange={(v) => go({ book: v as ReportState['book'] })}>
            <SelectTrigger
              className="w-40"
              aria-label={t('reports.bookLabel')}
              data-testid="report-book"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['all', 'cash', 'bank'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`reports.book.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {def.columns.some((c) => c.group) && (
          <Select
            value={state.group ?? 'none'}
            onValueChange={(v) => go({ group: v === 'none' ? null : v })}
          >
            <SelectTrigger
              className="w-44"
              aria-label={t('reports.groupBy')}
              data-testid="report-group"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('reports.noGroup')}</SelectItem>
              {def.columns
                .filter((c) => c.group)
                .map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {t('reports.groupedBy', { column: header(c) })}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="report-columns">
                {t('reports.columns')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {def.columns.map((c) => {
                const on = shown.includes(c.key);
                return (
                  <DropdownMenuItem
                    key={c.key}
                    data-testid={`report-col-${c.key}`}
                    onSelect={(e) => {
                      e.preventDefault();
                      const next = on
                        ? shown.filter((k) => k !== c.key)
                        : def.columns
                            .filter((x) => x.key === c.key || shown.includes(x.key))
                            .map((x) => x.key);
                      if (next.length > 0) go({ cols: next });
                    }}
                  >
                    <span className="w-4">{on ? '✓' : ''}</span> {header(c)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="report-views">
                {t('reports.views')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {views.views.length === 0 && (
                <p className="px-2 py-1 text-sm text-fg-muted">{t('reports.noViews')}</p>
              )}
              {views.views.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  data-testid="report-saved-view"
                  onSelect={() => navigate(`/${shell}/reports`, v.search)}
                >
                  <span className="flex-1">{v.name}</span>
                  <button
                    type="button"
                    aria-label={t('reports.deleteView', { name: v.name })}
                    className="px-1 text-fg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      void views.remove(v.id);
                    }}
                  >
                    ×
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <SaveViewPopover
            onSave={async (name) => {
              await views.save(name, writeReportState(state));
              toast.success(t('reports.viewSaved', { name }));
            }}
          />

          <Button
            variant="outline"
            data-testid="report-export-csv"
            disabled={busy !== null}
            onClick={() => void doExport('csv')}
          >
            {busy === 'csv' ? t('reports.exporting') : t('reports.csv')}
          </Button>
          <Button
            variant="outline"
            data-testid="report-export-xlsx"
            disabled={busy !== null}
            onClick={() => void doExport('xlsx')}
          >
            {busy === 'xlsx' ? t('reports.exporting') : t('reports.xlsx')}
          </Button>
          <Button
            variant="outline"
            data-testid="report-print"
            disabled={busy !== null || empty}
            onClick={() => void doPrint()}
          >
            {t('reports.print')}
          </Button>
        </div>
      </div>

      <p className="text-sm text-fg-muted" data-testid="report-summary">
        {data.isLoading
          ? t('reports.loading')
          : t('reports.summary', { count: data.count, shown: data.rows.length, ms: data.ms ?? 0 })}
      </p>

      {data.error ? (
        <p role="alert" className="text-danger" data-testid="report-error">
          {data.error.message}
        </p>
      ) : empty ? (
        <EmptyState title={t('reports.empty')} description={t('reports.emptyHint')} />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col rounded-md border border-border"
          data-testid="report-table"
        >
          <div
            className="grid gap-2 border-b border-border bg-surface-1 px-2 py-1 text-xs font-semibold uppercase text-fg-muted"
            style={{ gridTemplateColumns: template }}
            role="row"
          >
            {columns.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                className={isNumericKind(c.kind) ? 'text-right' : ''}
              >
                {header(c)}
              </div>
            ))}
          </div>
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-testid="report-scroll">
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {items.map((vi) => {
                const line = lines[vi.index]!;
                const style = {
                  position: 'absolute' as const,
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${vi.start}px)`,
                  gridTemplateColumns: template,
                };
                if (line.kind === 'group') {
                  return (
                    <div
                      key={vi.key}
                      style={{ ...style, display: 'flex' }}
                      className="items-center bg-surface-1 px-2 text-sm font-semibold"
                      data-testid="report-group-row"
                    >
                      {line.label}{' '}
                      <span className="pl-2 font-normal text-fg-muted">({line.count})</span>
                    </div>
                  );
                }
                if (line.kind === 'subtotal') {
                  return (
                    <div
                      key={vi.key}
                      style={style}
                      className="grid items-center gap-2 border-t border-border px-2 text-sm font-semibold"
                      data-testid="report-subtotal"
                    >
                      {columns.map((c, i) => (
                        <div
                          key={c.key}
                          className={isNumericKind(c.kind) ? 'tabular text-right' : ''}
                        >
                          {c.total && line.totals[c.key] !== undefined
                            ? showCell(state.id, c, line.totals[c.key], tr)
                            : i === 0
                              ? t('reports.subtotal')
                              : ''}
                        </div>
                      ))}
                    </div>
                  );
                }
                const row = line.row;
                const clickable = !!def.drill && !!row['id'];
                return (
                  <div
                    key={vi.key}
                    style={style}
                    role="row"
                    tabIndex={clickable ? 0 : undefined}
                    data-testid="report-row"
                    data-id={String(row['id'] ?? '')}
                    className={`grid items-center gap-2 border-t border-border px-2 text-sm ${clickable ? 'cursor-pointer hover:bg-surface-1' : ''}`}
                    onClick={() => clickable && open(row)}
                    onKeyDown={(e) => {
                      if (clickable && e.key === 'Enter') open(row);
                    }}
                  >
                    {columns.map((c) => (
                      <div
                        key={c.key}
                        data-col={c.key}
                        className={`truncate ${isNumericKind(c.kind) ? 'tabular text-right' : ''}`}
                      >
                        {showCell(state.id, c, row[c.key], tr)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          {totalsKnown && (
            <div
              className="grid items-center gap-2 border-t-2 border-border bg-surface-1 px-2 py-1 text-sm font-semibold"
              style={{ gridTemplateColumns: template }}
              data-testid="report-totals"
              role="row"
            >
              {columns.map((c, i) => (
                <div
                  key={c.key}
                  data-col={c.key}
                  className={isNumericKind(c.kind) ? 'tabular text-right' : ''}
                >
                  {c.total && data.totals[c.key] !== undefined
                    ? showCell(state.id, c, data.totals[c.key], tr)
                    : i === 0
                      ? t('reports.total')
                      : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {printRows &&
        createPortal(
          <PrintSheet
            title={title}
            business={String(business?.['name'] ?? '')}
            gstin={String(business?.['gstin'] ?? '')}
            state={state}
            columns={columns}
            rows={printRows}
            totals={data.totals}
            tr={tr}
            header={header}
            lang={i18n.language}
          />,
          document.body,
        )}
    </div>
  );
}

/** The report as a plain table for paper: business, title, period, then every row and the totals. */
function PrintSheet(props: {
  title: string;
  business: string;
  gstin: string;
  state: ReportState;
  columns: ReturnType<typeof exportColumns>;
  rows: ReportRow[];
  totals: Record<string, number>;
  tr: Translate;
  header: (c: { key: string }) => string;
  lang: string;
}) {
  const { t } = useTranslation();
  const { columns, rows, totals, tr, state } = props;
  return (
    <div
      className="print-area hidden p-[10mm] text-[9pt] text-black print:block"
      data-testid="report-print-sheet"
      lang={props.lang}
    >
      <h1 className="text-lg font-bold">{props.business}</h1>
      {props.gstin && <p>GSTIN {props.gstin}</p>}
      <h2 className="pt-2 text-base font-semibold">{props.title}</h2>
      <p className="pb-2">{t('reports.printPeriod', { from: state.from, to: state.to })}</p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`border-b border-black py-1 ${isNumericKind(c.kind) ? 'text-right' : 'text-left'}`}
              >
                {props.header(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="break-inside-avoid">
              {columns.map((c) => (
                <td key={c.key} className={`py-0.5 ${isNumericKind(c.kind) ? 'text-right' : ''}`}>
                  {showCell(state.id, c, r[c.key], tr)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {columns.some((c) => c.total) && (
          <tfoot>
            <tr className="font-bold">
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={`border-t border-black py-1 ${isNumericKind(c.kind) ? 'text-right' : ''}`}
                >
                  {c.total && totals[c.key] !== undefined
                    ? showCell(state.id, c, totals[c.key], tr)
                    : i === 0
                      ? t('reports.total')
                      : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export { PAGE_ROWS };
