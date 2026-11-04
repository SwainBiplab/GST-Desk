/**
 * What a report page needs besides the data: the parameters as they live in the address bar, how a
 * cell is shown and exported, and grouping with subtotals. No React here, so it is unit tested.
 */
import {
  REPORTS,
  isReportId,
  type ReportColumn,
  type ReportDef,
  type ReportId,
  type ReportParams,
  type ReportRow,
} from '@gst/db';
import {
  PERIOD_PRESETS,
  resolvePeriod,
  toCsv,
  toDecimalString,
  type CsvValue,
  type PeriodPreset,
} from '@gst/domain';
import { formatPaise } from '@gst/ui';

import type { XlsxCell, XlsxSheet } from './xlsx';

/* ------------------------------------------------------------------ address bar */

/** Everything that decides what a report shows, as the address bar keeps it. */
export interface ReportState {
  id: ReportId;
  preset: PeriodPreset;
  from: string;
  to: string;
  partyId: string | null;
  type: string | null;
  side: 'all' | 'receivable' | 'payable';
  book: 'all' | 'cash' | 'bank';
  /** Column key rows are grouped by, if any. */
  group: string | null;
  /** Columns shown, in order; null means the report's own defaults. */
  cols: string[] | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const defaultColumns = (def: ReportDef): string[] =>
  def.columns.filter((c) => !c.hidden).map((c) => c.key);

/** The state an address asks for, with every missing or wrong value replaced by the default. */
export function readReportState(
  search: Record<string, unknown>,
  today: string,
  fyStartMonth = 4,
): ReportState | null {
  const id = str(search['report']);
  if (!id || !isReportId(id)) return null;
  const def = REPORTS[id];
  const asked = str(search['preset']);
  const preset: PeriodPreset =
    asked && (PERIOD_PRESETS as readonly string[]).includes(asked)
      ? (asked as PeriodPreset)
      : str(search['from']) || str(search['to'])
        ? 'custom'
        : 'this_fy';
  const base = resolvePeriod(preset, today, fyStartMonth);
  const from = str(search['from']);
  const to = str(search['to']);
  const fromOk = preset === 'custom' && from && ISO.test(from) ? from : base.from;
  const toOk = preset === 'custom' && to && ISO.test(to) ? to : base.to;
  const type = str(search['type']);
  const side = str(search['side']);
  const book = str(search['book']);
  const group = str(search['group']);
  const cols = str(search['cols'])
    ?.split(',')
    .filter((k) => def.columns.some((c) => c.key === k));
  return {
    id,
    preset,
    from: fromOk <= toOk ? fromOk : toOk,
    to: fromOk <= toOk ? toOk : fromOk,
    partyId: str(search['party']),
    // the first type option is the default when a report has options that cannot be combined
    type: type && (!def.typeOptions || def.typeOptions.includes(type)) ? type : defaultType(def),
    side: side === 'all' || side === 'payable' ? side : 'receivable',
    book: book === 'cash' || book === 'bank' ? book : 'all',
    group: group && def.columns.some((c) => c.key === group && c.group) ? group : null,
    cols: cols && cols.length > 0 ? cols : null,
  };
}

/** gst_summary reads one side at a time, so it always has a type. The registers cover all of theirs. */
function defaultType(def: ReportDef): string | null {
  return def.id === 'gst_summary' ? 'outward' : null;
}

/** The address search for a state. Defaults are left out so addresses stay short. */
export function writeReportState(s: ReportState): Record<string, string> {
  const def = REPORTS[s.id];
  const out: Record<string, string> = { report: s.id };
  if (s.preset !== 'this_fy') out['preset'] = s.preset;
  if (s.preset === 'custom') {
    out['from'] = s.from;
    out['to'] = s.to;
  }
  if (s.partyId) out['party'] = s.partyId;
  if (s.type && s.type !== defaultType(def)) out['type'] = s.type;
  if (s.side !== 'receivable') out['side'] = s.side;
  if (s.book !== 'all') out['book'] = s.book;
  if (s.group) out['group'] = s.group;
  if (s.cols) out['cols'] = s.cols.join(',');
  return out;
}

/** The query a state stands for. `today` is the caller's date, used for ageing. */
export function toParams(s: ReportState, today: string): ReportParams {
  const p: ReportParams = { from: s.from, to: s.to, today };
  if (s.partyId) p.partyId = s.partyId;
  if (s.type) p.type = s.type;
  p.side = s.side;
  p.book = s.book;
  return p;
}

/* ------------------------------------------------------------------ showing cells */

export type Translate = (key: string, opts?: Record<string, unknown>) => string;

const ddmmyyyy = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(iso)
    ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`
    : iso;

/** Quantities are kept in millionths; show up to three decimals without trailing zeros. */
export function qtyText(micros: number): string {
  const neg = micros < 0;
  const abs = Math.abs(Math.round(micros));
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000)
    .padStart(6, '0')
    .slice(0, 3)
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A rate in basis points as a percentage: 1800 is 18%, 250 is 2.5%. */
export const rateText = (bp: number): string =>
  `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2).replace(/0+$/, '')}%`;

/** The words a text cell shows for the coded values reports use. */
export function textCell(id: ReportId, key: string, value: string, t: Translate): string {
  if (!value) return '';
  if (key === 'type' && id !== 'gst_summary')
    return t(`docs.types.${value}`, { defaultValue: value });
  if (key === 'kind') {
    if (value === 'receipt' || value === 'payment') return t(`reports.kind.${value}`);
    return t(`docs.types.${value}`, { defaultValue: value });
  }
  if (key === 'mode') return t(`pay.modes.${value}`, { defaultValue: value });
  if (key === 'supply') return t(`reports.supply.${value}`, { defaultValue: value });
  if (key === 'bucket') return t(`reports.bucket.${value}`, { defaultValue: value });
  if (key === 'party' && value === 'Walk-in') return t('reports.walkIn');
  return value;
}

/** A cell as shown on screen. */
export function showCell(id: ReportId, col: ReportColumn, value: unknown, t: Translate): string {
  if (value === null || value === undefined || value === '') return '';
  switch (col.kind) {
    case 'money':
      return formatPaise(Math.round(Number(value)), { symbol: false });
    case 'qty':
      return qtyText(Number(value));
    case 'int':
      return String(Math.round(Number(value)));
    case 'rate':
      return rateText(Number(value));
    case 'date':
      return ddmmyyyy(String(value));
    case 'text':
      return textCell(id, col.key, String(value), t);
  }
}

export const isNumericKind = (kind: ReportColumn['kind']): boolean =>
  kind === 'money' || kind === 'qty' || kind === 'int' || kind === 'rate';

/* ------------------------------------------------------------------ grouping */

export type Line =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'row'; row: ReportRow }
  | { kind: 'subtotal'; key: string; totals: Record<string, number> };

/** Sum the columns marked `total` over some rows. */
export function totalsOf(columns: ReportColumn[], rows: ReportRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of columns) {
    if (c.total) out[c.key] = rows.reduce((a, r) => a + Number(r[c.key] ?? 0), 0);
  }
  return out;
}

/**
 * Rows in display order. With a grouping column the rows gather under a heading per distinct value
 * (in order of first appearance, or by the value for text) and each group ends with a subtotal.
 */
export function layoutLines(
  id: ReportId,
  columns: ReportColumn[],
  rows: ReportRow[],
  group: string | null,
  t: Translate,
): Line[] {
  if (!group) return rows.map((row) => ({ kind: 'row', row }));
  const col = columns.find((c) => c.key === group);
  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = String(r[group] ?? '');
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const label = (k: string) =>
    col ? showCell(id, col, k, t) || t('reports.blank') : k || t('reports.blank');
  const keys = [...groups.keys()].sort((a, b) => label(a).localeCompare(label(b)));
  const out: Line[] = [];
  for (const k of keys) {
    const list = groups.get(k)!;
    out.push({ kind: 'group', key: k, label: label(k), count: list.length });
    for (const row of list) out.push({ kind: 'row', row });
    out.push({ kind: 'subtotal', key: k, totals: totalsOf(columns, list) });
  }
  return out;
}

/* ------------------------------------------------------------------ export */

/** The column keys to export: what is on screen, in the order shown. */
export function exportColumns(def: ReportDef, chosen: string[] | null): ReportColumn[] {
  const keys = chosen ?? defaultColumns(def);
  return keys.map((k) => def.columns.find((c) => c.key === k)!).filter(Boolean);
}

const rupees = (paise: number): string => toDecimalString(BigInt(Math.round(paise)), 2);

/** A cell as a CSV value: amounts as plain decimals, text escaped so a spreadsheet will not run it. */
export function csvValue(id: ReportId, col: ReportColumn, value: unknown, t: Translate): CsvValue {
  if (value === null || value === undefined || value === '') return '';
  switch (col.kind) {
    case 'money':
      return { numeric: rupees(Number(value)) };
    case 'qty':
      return {
        numeric: toDecimalString(BigInt(Math.round(Number(value))), 6).replace(/\.?0+$/, ''),
      };
    case 'int':
      return { numeric: String(Math.round(Number(value))) };
    case 'rate':
      return { numeric: toDecimalString(BigInt(Math.round(Number(value))), 2) };
    case 'date':
      return String(value);
    case 'text':
      return textCell(id, col.key, String(value), t);
  }
}

/** A cell for the workbook: real numbers with a number format, text as text. */
export function xlsxValue(id: ReportId, col: ReportColumn, value: unknown, t: Translate): XlsxCell {
  if (value === null || value === undefined || value === '') return null;
  switch (col.kind) {
    case 'money':
      return { n: Math.round(Number(value)) / 100, fmt: 'money' };
    case 'qty':
      return { n: Number(value) / 1_000_000, fmt: 'qty' };
    case 'int':
      return { n: Math.round(Number(value)), fmt: 'int' };
    case 'rate':
      return { n: Number(value) / 10_000, fmt: 'percent' };
    case 'date':
      return excelDate(String(value));
    case 'text':
      return textCell(id, col.key, String(value), t);
  }
}

/** A date as a spreadsheet date: days since 30 December 1899, shown as dd-mm-yyyy. Text if it is not a date. */
export function excelDate(iso: string): XlsxCell {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const days = Math.round(
    (Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - Date.UTC(1899, 11, 30)) / 86_400_000,
  );
  return { n: days, fmt: 'date' };
}

export interface ExportInput {
  id: ReportId;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number>;
  title: string;
  /** Label for the totals row. */
  totalLabel: string;
  header: (c: ReportColumn) => string;
  t: Translate;
}

const hasTotals = (columns: ReportColumn[], totals: Record<string, number>) =>
  columns.some((c) => c.total && totals[c.key] !== undefined);

export function toCsvText(x: ExportInput): string {
  const body: CsvValue[][] = [
    x.columns.map((c) => x.header(c)),
    ...x.rows.map((r) => x.columns.map((c) => csvValue(x.id, c, r[c.key], x.t))),
  ];
  if (hasTotals(x.columns, x.totals)) {
    body.push(
      x.columns.map((c, i) =>
        c.total && x.totals[c.key] !== undefined
          ? csvValue(x.id, c, x.totals[c.key], x.t)
          : i === 0
            ? x.totalLabel
            : '',
      ),
    );
  }
  return toCsv(body);
}

export function toSheet(x: ExportInput): XlsxSheet {
  const sheet: XlsxSheet = {
    name: x.title,
    header: x.columns.map((c) => x.header(c)),
    rows: x.rows.map((r) => x.columns.map((c) => xlsxValue(x.id, c, r[c.key], x.t))),
  };
  if (hasTotals(x.columns, x.totals)) {
    sheet.footer = x.columns.map((c, i) =>
      c.total && x.totals[c.key] !== undefined
        ? xlsxValue(x.id, c, x.totals[c.key], x.t)
        : i === 0
          ? x.totalLabel
          : null,
    );
  }
  return sheet;
}
