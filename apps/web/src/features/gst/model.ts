/**
 * The Filing Desk without React: which periods to show, a card's status, the table summaries of a
 * review, and the files an export produces. Unit tested in `model.test.ts`.
 */
import type { FilingRecord } from '@gst/db';
import {
  addDaysIso,
  dueDate,
  filingStatus,
  gstr1Csv,
  gstr1Json,
  gstr3bJson,
  periodsBetween,
  type FilingStatus,
  type GstrPeriod,
  type PeriodReview,
  type Return,
} from '@gst/domain';
import { strToU8, zipSync } from 'fflate';

export type FilingKind = 'month' | 'quarter';

/** The periods a business can still be working on: the last twelve months or four quarters, newest first. */
export function recentPeriods(gstin: string, today: string, kind: FilingKind): GstrPeriod[] {
  const back = kind === 'month' ? 365 : 395;
  const list = periodsBetween(gstin, addDaysIso(today, -back), today, kind);
  return list.slice(-(kind === 'month' ? 12 : 4)).reverse();
}

export interface CardState {
  status: FilingStatus;
  due: string;
  overridden: boolean;
  filing: FilingRecord | null;
}

export function cardState(input: {
  ret: Return;
  period: GstrPeriod;
  stateCode: string;
  filing: FilingRecord | null;
  review: Pick<PeriodReview, 'blockers' | 'hasDocuments'> | null;
  today: string;
}): CardState {
  const { date, overridden } = dueDate(
    input.ret,
    input.period,
    input.stateCode,
    input.filing?.dueOverride
      ? { [`${input.ret}:${input.period.fp}`]: input.filing.dueOverride }
      : {},
  );
  const status = filingStatus({
    filed: input.filing?.status === 'filed',
    exported: input.filing?.status === 'exported',
    hasDocuments: input.review?.hasDocuments ?? false,
    blockers: input.review?.blockers ?? 0,
    today: input.today,
    due: date,
  });
  return { status, due: date, overridden, filing: input.filing };
}

/** A period's heading: "Apr 2025", or "Apr to Jun 2025" for a quarter. */
export function periodLabel(p: GstrPeriod, locale: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  if (p.kind === 'month') return fmt(p.from, { month: 'short', year: 'numeric' });
  return `${fmt(p.from, { month: 'short' })} – ${fmt(p.to, { month: 'short', year: 'numeric' })}`;
}

export interface TableRow {
  key: 'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur' | 'exp' | 'nil' | 'hsn' | 'docs';
  count: number;
  /** Paise; null when the table carries no money of its own (documents issued). */
  taxable: number | null;
  tax: number | null;
}

const tax = (r: { iamt: number; camt: number; samt: number; csamt: number }) =>
  r.iamt + r.camt + r.samt + r.csamt;

/** One line per GSTR-1 table: how many rows it will hold and what they add up to. */
export function gstr1Rows(review: PeriodReview): TableRow[] {
  const g = review.gstr1;
  const sumItems = (
    rows: { txval: number; iamt: number; camt: number; samt: number; csamt: number }[],
  ) => ({
    taxable: rows.reduce((a, r) => a + r.txval, 0),
    tax: rows.reduce((a, r) => a + tax(r), 0),
  });
  const b2b = g.b2b.flatMap((p) => p.invoices.flatMap((i) => i.items));
  const b2cl = g.b2cl.flatMap((p) => p.invoices.flatMap((i) => i.items));
  const cdnr = g.cdnr.flatMap((p) => p.notes.flatMap((n) => n.items.map((r) => ({ r, n }))));
  const cdnur = g.cdnur.flatMap((n) => n.items.map((r) => ({ r, n })));
  const signed = (
    rows: { r: Parameters<typeof tax>[0] & { txval: number }; n: { ntty: string } }[],
  ) => ({
    taxable: rows.reduce((a, { r, n }) => a + (n.ntty === 'C' ? -1 : 1) * r.txval, 0),
    tax: rows.reduce((a, { r, n }) => a + (n.ntty === 'C' ? -1 : 1) * tax(r), 0),
  });
  const exp = g.exp.flatMap((x) => x.invoices.flatMap((i) => i.items));
  const nilValue = g.nil.reduce((a, r) => a + r.exptAmt + r.nilAmt + r.ngsupAmt, 0);
  return [
    {
      key: 'b2b',
      count: g.b2b.reduce((a, p) => a + p.invoices.length, 0),
      ...sumItems(b2b),
    },
    { key: 'b2cl', count: g.b2cl.reduce((a, p) => a + p.invoices.length, 0), ...sumItems(b2cl) },
    { key: 'b2cs', count: g.b2cs.length, ...sumItems(g.b2cs) },
    { key: 'cdnr', count: g.cdnr.reduce((a, p) => a + p.notes.length, 0), ...signed(cdnr) },
    { key: 'cdnur', count: g.cdnur.length, ...signed(cdnur) },
    { key: 'exp', count: g.exp.reduce((a, x) => a + x.invoices.length, 0), ...sumItems(exp) },
    { key: 'nil', count: g.nil.length, taxable: nilValue, tax: null },
    {
      key: 'hsn',
      count: g.hsnB2b.length + g.hsnB2c.length,
      taxable: [...g.hsnB2b, ...g.hsnB2c].reduce((a, h) => a + h.txval, 0),
      tax: [...g.hsnB2b, ...g.hsnB2c].reduce((a, h) => a + tax(h), 0),
    },
    { key: 'docs', count: g.docs.reduce((a, r) => a + r.totnum, 0), taxable: null, tax: null },
  ];
}

/** File name parts that are safe on every system. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_');

export interface ExportFile {
  name: string;
  mime: string;
  data: string | Uint8Array;
}

export function gstr1JsonFile(review: PeriodReview): ExportFile {
  return {
    name: `GSTR1_${safe(review.period.gstin)}_${review.period.fp}.json`,
    mime: 'application/json',
    data: JSON.stringify(gstr1Json(review.gstr1), null, 2),
  };
}

export function gstr3bJsonFile(review: PeriodReview): ExportFile {
  return {
    name: `GSTR3B_${safe(review.period.gstin)}_${review.period.fp}.json`,
    mime: 'application/json',
    data: JSON.stringify(gstr3bJson(review.gstr3b), null, 2),
  };
}

/** One CSV per GSTR-1 table in a ZIP (a table with no rows is left out). */
export function gstr1CsvZip(review: PeriodReview): ExportFile {
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(gstr1Csv(review.gstr1))) {
    // a header row alone means the table is empty
    if (text.trim().split(/\r?\n/).length > 1) files[`${name}.csv`] = strToU8(text);
  }
  return {
    name: `GSTR1_${safe(review.period.gstin)}_${review.period.fp}_csv.zip`,
    mime: 'application/zip',
    data: zipSync(files),
  };
}
