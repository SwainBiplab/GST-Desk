/**
 * Reports (FR-070, FR-071) and the numbers on the dashboards (FR-073, UX-06).
 *
 * Every report is one function from a business, a period and a few filters to rows and a totals line,
 * computed by grouped SQL over the issued documents, their lines and the payment allocations. Nothing
 * is cached or stored: the registers read the same rows the editor wrote, so a figure here cannot drift
 * from the document it came from. Which documents count toward turnover and purchases comes from one
 * place in the domain package (`TURNOVER_PLUS` and friends) and is turned into SQL here.
 *
 * Register-style reports page (`offset`, `limit`) so the first page appears at once on 50,000
 * documents; their totals come from one aggregate query over the whole filtered set.
 */
import {
  addDays,
  PURCHASE_MINUS,
  PURCHASE_PLUS,
  TURNOVER_MINUS,
  TURNOVER_PLUS,
  AGEING_BUCKETS,
  ageInto,
  daysPastDue,
  divRound,
  emptyAgeing,
  filingCalendar,
  resolvePeriod,
  returnsUqc,
  sameDaysLastMonth,
  type AgeingBucket,
  type AgeingRow,
  type FilingDue,
} from '@gst/domain';
import { sql, type SQL } from 'drizzle-orm';

import { queryRows, type Database } from '../database';

import { runInTx, type Ctx } from './base';

/* ------------------------------------------------------------------ definitions */

export type ColumnKind = 'text' | 'date' | 'money' | 'qty' | 'int' | 'rate';

export interface ReportColumn {
  key: string;
  kind: ColumnKind;
  /** Summed in the totals row. */
  total?: boolean;
  /** Offered as a grouping field in the report page. */
  group?: boolean;
  /** Left out until chosen in the column chooser. */
  hidden?: boolean;
}

export const REPORT_IDS = [
  'sales_register',
  'purchase_register',
  'note_register',
  'party_outstanding',
  'receivables_payables',
  'gst_summary',
  'hsn_summary',
  'document_summary',
  'expense_summary',
  'receipts_payments',
  'day_book',
  'stock_summary',
  'party_sales',
  'item_sales',
] as const;
export type ReportId = (typeof REPORT_IDS)[number];
export const isReportId = (v: string): v is ReportId =>
  (REPORT_IDS as readonly string[]).includes(v);

export type ReportFilter = 'period' | 'party' | 'type' | 'side' | 'book' | 'asOf';

export interface ReportDef {
  id: ReportId;
  section: 'registers' | 'gst' | 'parties' | 'money' | 'stock';
  columns: ReportColumn[];
  /** Runs page by page (registers). The rest return every row at once. */
  paged: boolean;
  filters: ReportFilter[];
  /** Values the `type` filter accepts (the first is the default when there is one). */
  typeOptions?: string[];
  /** What a row opens: the document or the party it came from. */
  drill: 'document' | 'party' | null;
  /** Hidden unless this business feature flag is on. */
  flag?: 'inventory';
}

const money = (key: string, extra: Partial<ReportColumn> = {}): ReportColumn => ({
  key,
  kind: 'money',
  total: true,
  ...extra,
});
const text = (key: string, extra: Partial<ReportColumn> = {}): ReportColumn => ({
  key,
  kind: 'text',
  ...extra,
});

const TAX_COLUMNS: ReportColumn[] = [
  money('taxable'),
  money('cgst'),
  money('sgst'),
  money('igst'),
  money('cess', { hidden: true }),
];

export const REPORTS: Record<ReportId, ReportDef> = {
  sales_register: {
    id: 'sales_register',
    section: 'registers',
    paged: true,
    drill: 'document',
    filters: ['period', 'party', 'type'],
    typeOptions: [...TURNOVER_PLUS, ...TURNOVER_MINUS],
    columns: [
      { key: 'date', kind: 'date' },
      text('number'),
      text('type', { group: true }),
      text('party', { group: true }),
      text('gstin', { hidden: true }),
      text('place', { group: true, hidden: true }),
      ...TAX_COLUMNS,
      money('total'),
    ],
  },
  purchase_register: {
    id: 'purchase_register',
    section: 'registers',
    paged: true,
    drill: 'document',
    filters: ['period', 'party', 'type'],
    typeOptions: [...PURCHASE_PLUS, ...PURCHASE_MINUS],
    columns: [
      { key: 'date', kind: 'date' },
      text('number'),
      text('type', { group: true }),
      text('party', { group: true }),
      text('gstin', { hidden: true }),
      text('place', { group: true, hidden: true }),
      ...TAX_COLUMNS,
      money('total'),
    ],
  },
  note_register: {
    id: 'note_register',
    section: 'registers',
    paged: true,
    drill: 'document',
    filters: ['period', 'party', 'type'],
    typeOptions: ['credit_note', 'debit_note'],
    columns: [
      { key: 'date', kind: 'date' },
      text('number'),
      text('type', { group: true }),
      text('party', { group: true }),
      text('against'),
      text('gstin', { hidden: true }),
      ...TAX_COLUMNS,
      money('total'),
    ],
  },
  party_outstanding: {
    id: 'party_outstanding',
    section: 'parties',
    paged: false,
    drill: 'party',
    filters: ['party', 'side', 'asOf'],
    columns: [
      text('party'),
      text('gstin', { hidden: true }),
      money('opening', { hidden: true }),
      money('notDue'),
      money('d1_30'),
      money('d31_60'),
      money('d61_90'),
      money('d90plus'),
      money('credit'),
      money('outstanding'),
    ],
  },
  receivables_payables: {
    id: 'receivables_payables',
    section: 'parties',
    paged: false,
    drill: null,
    filters: ['asOf'],
    columns: [text('bucket'), money('receivable'), money('payable')],
  },
  gst_summary: {
    id: 'gst_summary',
    section: 'gst',
    paged: false,
    drill: null,
    filters: ['period', 'type'],
    typeOptions: ['outward', 'inward'],
    columns: [
      text('supply', { group: true }),
      { key: 'rate', kind: 'rate', group: true },
      money('taxable'),
      money('igst'),
      money('cgst'),
      money('sgst'),
      money('cess'),
      money('tax'),
    ],
  },
  hsn_summary: {
    id: 'hsn_summary',
    section: 'gst',
    paged: false,
    drill: null,
    filters: ['period'],
    columns: [
      text('hsn', { group: true }),
      text('description', { hidden: true }),
      text('uqc', { group: true }),
      { key: 'qty', kind: 'qty', total: false },
      { key: 'rate', kind: 'rate', group: true },
      money('value'),
      money('taxable'),
      money('igst'),
      money('cgst'),
      money('sgst'),
      money('cess'),
    ],
  },
  document_summary: {
    id: 'document_summary',
    section: 'gst',
    paged: false,
    drill: null,
    filters: ['period'],
    columns: [
      text('type', { group: true }),
      text('series', { group: true }),
      text('from'),
      text('to'),
      { key: 'total', kind: 'int', total: true },
      { key: 'cancelled', kind: 'int', total: true },
      { key: 'net', kind: 'int', total: true },
    ],
  },
  expense_summary: {
    id: 'expense_summary',
    section: 'money',
    paged: false,
    drill: null,
    filters: ['period', 'party'],
    columns: [
      text('category', { group: true }),
      { key: 'count', kind: 'int', total: true },
      money('taxable'),
      money('tax'),
      money('total'),
    ],
  },
  receipts_payments: {
    id: 'receipts_payments',
    section: 'money',
    paged: true,
    drill: null,
    filters: ['period', 'party', 'book'],
    columns: [
      { key: 'date', kind: 'date' },
      text('party', { group: true }),
      text('mode', { group: true }),
      text('reference'),
      money('receipt'),
      money('payment'),
    ],
  },
  day_book: {
    id: 'day_book',
    section: 'money',
    paged: true,
    drill: 'document',
    filters: ['period', 'party'],
    columns: [
      { key: 'date', kind: 'date' },
      text('kind', { group: true }),
      text('number'),
      text('party', { group: true }),
      { key: 'amount', kind: 'money' },
    ],
  },
  stock_summary: {
    id: 'stock_summary',
    section: 'stock',
    paged: false,
    drill: null,
    flag: 'inventory',
    filters: ['period', 'type'],
    /** `low`: only the items below their reorder level. */
    typeOptions: ['low'],
    columns: [
      text('item'),
      text('sku', { hidden: true }),
      { key: 'opening', kind: 'qty' },
      { key: 'in', kind: 'qty' },
      { key: 'out', kind: 'qty' },
      { key: 'closing', kind: 'qty' },
      { key: 'rate', kind: 'money', hidden: true },
      money('value'),
      { key: 'min', kind: 'qty', hidden: true },
    ],
  },
  party_sales: {
    id: 'party_sales',
    section: 'parties',
    paged: false,
    drill: 'party',
    filters: ['period'],
    columns: [
      text('party'),
      text('gstin', { hidden: true }),
      { key: 'salesCount', kind: 'int', total: true, hidden: true },
      money('sales'),
      { key: 'purchaseCount', kind: 'int', total: true, hidden: true },
      money('purchases'),
    ],
  },
  item_sales: {
    id: 'item_sales',
    section: 'stock',
    paged: false,
    drill: null,
    filters: ['period', 'party'],
    columns: [
      text('item'),
      text('hsn', { group: true }),
      { key: 'qty', kind: 'qty' },
      money('taxable'),
      money('tax'),
      money('total'),
    ],
  },
};

export interface ReportParams {
  /** Inclusive, ISO. */
  from: string;
  to: string;
  /** The caller's date: ageing and "as of" reports count days from it. */
  today: string;
  partyId?: string;
  type?: string;
  side?: 'all' | 'receivable' | 'payable';
  book?: 'all' | 'cash' | 'bank';
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportResult {
  id: ReportId;
  rows: ReportRow[];
  /** Rows in the whole filtered set (not only this page). */
  count: number;
  /** Column key to its sum over the whole filtered set. */
  totals: Record<string, number>;
}

export interface ReportPage {
  offset: number;
  limit: number;
}

/* ------------------------------------------------------------------ helpers */

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const list = (types: readonly string[]): SQL =>
  sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );
/** `1` for documents that add, `-1` for the ones that subtract, as SQL. */
const signOf = (minus: readonly string[], alias = 'd'): SQL =>
  sql.raw(
    `(CASE WHEN ${alias}.type IN (${minus.map((t) => `'${t}'`).join(', ')}) THEN -1 ELSE 1 END)`,
  );

const col = (name: string, alias = 'd'): SQL => sql.raw(`${alias}.${name}`);

/** Issued documents of these types in the period, for this business (and one party when asked). */
function docWhere(ctx: Ctx, p: ReportParams, types: readonly string[], alias = 'd'): SQL {
  const wanted = p.type && types.includes(p.type) ? [p.type] : types;
  return sql`${col('business_id', alias)} = ${ctx.businessId} AND ${col('deleted_at', alias)} IS NULL
    AND ${col('status', alias)} = 'issued' AND ${col('type', alias)} IN (${list(wanted)})
    AND ${col('date', alias)} >= ${p.from} AND ${col('date', alias)} <= ${p.to}
    ${p.partyId ? sql`AND ${col('party_id', alias)} = ${p.partyId}` : sql``}`;
}

/** The same filters without the document-type choice, for reports that always cover the same types. */
function untyped(p: ReportParams): ReportParams {
  const rest = { ...p };
  delete rest.type;
  return rest;
}

function sumTotals(columns: ReportColumn[], rows: ReportRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const c of columns) {
    if (!c.total) continue;
    totals[c.key] = rows.reduce((acc, r) => acc + n(r[c.key]), 0);
  }
  return totals;
}

const whole = (id: ReportId, rows: ReportRow[]): ReportResult => ({
  id,
  rows,
  count: rows.length,
  totals: sumTotals(REPORTS[id].columns, rows),
});

/* ------------------------------------------------------------------ registers */

async function register(
  d: Database,
  tx: any,
  ctx: Ctx,
  id: 'sales_register' | 'purchase_register',
  p: ReportParams,
  page: ReportPage | undefined,
): Promise<ReportResult> {
  const plus = id === 'sales_register' ? TURNOVER_PLUS : PURCHASE_PLUS;
  const minus = id === 'sales_register' ? TURNOVER_MINUS : PURCHASE_MINUS;
  const where = docWhere(ctx, p, [...plus, ...minus]);
  const sg = signOf(minus);
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT d.id, d.date, d.number, d.type, coalesce(d.party_name, '') AS party, coalesce(pa.gstin, '') AS gstin,
               coalesce(d.place_of_supply_state, '') AS place,
               ${sg} * d.total_taxable_paise AS taxable, ${sg} * d.total_cgst_paise AS cgst,
               ${sg} * (d.total_sgst_paise + d.total_utgst_paise) AS sgst, ${sg} * d.total_igst_paise AS igst,
               ${sg} * d.total_cess_paise AS cess, ${sg} * d.total_paise AS total
        FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
        WHERE ${where} ORDER BY d.date, d.number, d.id ${paging}`,
  );
  const agg = await queryRows(
    d,
    tx,
    sql`SELECT count(*) AS c, coalesce(sum(${sg} * d.total_taxable_paise), 0) AS taxable,
               coalesce(sum(${sg} * d.total_cgst_paise), 0) AS cgst,
               coalesce(sum(${sg} * (d.total_sgst_paise + d.total_utgst_paise)), 0) AS sgst,
               coalesce(sum(${sg} * d.total_igst_paise), 0) AS igst,
               coalesce(sum(${sg} * d.total_cess_paise), 0) AS cess,
               coalesce(sum(${sg} * d.total_paise), 0) AS total
        FROM documents d WHERE ${where}`,
  );
  const a = agg[0] ?? {};
  return {
    id,
    count: n(a['c']),
    rows: rows.map((r) => ({
      id: s(r['id']),
      date: s(r['date']),
      number: s(r['number']),
      type: s(r['type']),
      party: s(r['party']),
      gstin: s(r['gstin']),
      place: s(r['place']),
      taxable: n(r['taxable']),
      cgst: n(r['cgst']),
      sgst: n(r['sgst']),
      igst: n(r['igst']),
      cess: n(r['cess']),
      total: n(r['total']),
    })),
    totals: {
      taxable: n(a['taxable']),
      cgst: n(a['cgst']),
      sgst: n(a['sgst']),
      igst: n(a['igst']),
      cess: n(a['cess']),
      total: n(a['total']),
    },
  };
}

async function noteRegister(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
  page: ReportPage | undefined,
): Promise<ReportResult> {
  const where = docWhere(ctx, p, ['credit_note', 'debit_note']);
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT d.id, d.date, d.number, d.type, coalesce(d.party_name, '') AS party, coalesce(pa.gstin, '') AS gstin,
               coalesce(src.number, '') AS against,
               d.total_taxable_paise AS taxable, d.total_cgst_paise AS cgst,
               (d.total_sgst_paise + d.total_utgst_paise) AS sgst, d.total_igst_paise AS igst,
               d.total_cess_paise AS cess, d.total_paise AS total
        FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
        LEFT JOIN documents src ON src.id = d.source_document_id
        WHERE ${where} ORDER BY d.date, d.number, d.id ${paging}`,
  );
  const agg = await queryRows(
    d,
    tx,
    sql`SELECT count(*) AS c, coalesce(sum(d.total_taxable_paise), 0) AS taxable,
               coalesce(sum(d.total_cgst_paise), 0) AS cgst,
               coalesce(sum(d.total_sgst_paise + d.total_utgst_paise), 0) AS sgst,
               coalesce(sum(d.total_igst_paise), 0) AS igst,
               coalesce(sum(d.total_cess_paise), 0) AS cess, coalesce(sum(d.total_paise), 0) AS total
        FROM documents d WHERE ${where}`,
  );
  const a = agg[0] ?? {};
  return {
    id: 'note_register',
    count: n(a['c']),
    rows: rows.map((r) => ({
      id: s(r['id']),
      date: s(r['date']),
      number: s(r['number']),
      type: s(r['type']),
      party: s(r['party']),
      gstin: s(r['gstin']),
      against: s(r['against']),
      taxable: n(r['taxable']),
      cgst: n(r['cgst']),
      sgst: n(r['sgst']),
      igst: n(r['igst']),
      cess: n(r['cess']),
      total: n(r['total']),
    })),
    totals: {
      taxable: n(a['taxable']),
      cgst: n(a['cgst']),
      sgst: n(a['sgst']),
      igst: n(a['igst']),
      cess: n(a['cess']),
      total: n(a['total']),
    },
  };
}

/* ------------------------------------------------------------------ what is owed */

const RECEIVABLE_DOCS = ['tax_invoice', 'bill_of_supply', 'debit_note'] as const;
const PAYABLE_DOCS = ['purchase_bill', 'expense'] as const;
const CREDIT_OF_RECEIVED = ['credit_note'] as const;
const CREDIT_OF_MADE = ['purchase_return'] as const;

/** A payment that settles something: no payment at all (credit between documents) or one that cleared. */
const SETTLES = sql`(a.payment_id IS NULL OR (p.status = 'cleared' AND p.deleted_at IS NULL))`;

export interface OpenDoc {
  id: string;
  number: string | null;
  type: string;
  date: string;
  dueDate: string | null;
  partyId: string | null;
  partyName: string;
  /** `receivable` when the party owes us. */
  side: 'receivable' | 'payable';
  balancePaise: number;
}

export interface PartyBalances {
  docs: OpenDoc[];
  /** Unused credit in the party's favour, positive amounts, by party and side. */
  credit: { partyId: string; side: 'receivable' | 'payable'; paise: number }[];
  opening: Map<string, { name: string; gstin: string; paise: number }>;
}

/**
 * What every party owes and is owed, as of `today`: balances of unsettled documents, unused credit
 * notes and advances, and opening balances. The same rules as `PaymentFlowRepo.positions`
 * (allocations of payments that did not clear settle nothing), in grouped SQL so it stays fast on
 * a large book; a test holds the two to the same answer.
 */
export async function partyBalancesIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  opts: { partyId?: string } = {},
): Promise<PartyBalances> {
  const b = ctx.businessId;
  const only = opts.partyId ? sql`AND d.party_id = ${opts.partyId}` : sql``;
  const docs = await queryRows(
    d,
    tx,
    sql`SELECT d.id, d.number, d.type, d.date, d.due_date, d.party_id, coalesce(d.party_name, '') AS party,
               d.total_paise - coalesce(s.v, 0) AS balance
        FROM documents d
        LEFT JOIN (
          SELECT a.document_id AS k, sum(a.amount_paise) AS v
          FROM payment_allocations a LEFT JOIN payments p ON p.id = a.payment_id
          WHERE a.business_id = ${b} AND a.deleted_at IS NULL AND ${SETTLES}
          GROUP BY a.document_id
        ) s ON s.k = d.id
        WHERE d.business_id = ${b} AND d.deleted_at IS NULL AND d.status = 'issued'
          AND d.type IN (${list([...RECEIVABLE_DOCS, ...PAYABLE_DOCS])}) ${only}
          AND d.total_paise - coalesce(s.v, 0) <> 0`,
  );
  const creditDocs = await queryRows(
    d,
    tx,
    sql`SELECT d.id, d.type, d.party_id, d.total_paise - coalesce(s.v, 0) AS remaining
        FROM documents d
        LEFT JOIN (
          SELECT a.source_document_id AS k, sum(a.amount_paise) AS v
          FROM payment_allocations a LEFT JOIN payments p ON p.id = a.payment_id
          WHERE a.business_id = ${b} AND a.deleted_at IS NULL AND a.kind = 'credit_applied'
            AND a.source_document_id IS NOT NULL AND ${SETTLES}
          GROUP BY a.source_document_id
        ) s ON s.k = d.id
        WHERE d.business_id = ${b} AND d.deleted_at IS NULL AND d.status = 'issued'
          AND d.type IN (${list([...CREDIT_OF_RECEIVED, ...CREDIT_OF_MADE])}) ${only}
          AND d.total_paise - coalesce(s.v, 0) > 0`,
  );
  const advances = await queryRows(
    d,
    tx,
    sql`SELECT p.party_id, p.direction, p.amount_paise - p.tcs_paise - coalesce(s.v, 0) AS remaining
        FROM payments p
        LEFT JOIN (
          SELECT a.payment_id AS k, sum(a.amount_paise) AS v FROM payment_allocations a
          WHERE a.business_id = ${b} AND a.deleted_at IS NULL AND a.kind <> 'write_off' AND a.payment_id IS NOT NULL
          GROUP BY a.payment_id
        ) s ON s.k = p.id
        WHERE p.business_id = ${b} AND p.deleted_at IS NULL AND p.status = 'cleared' AND p.party_id IS NOT NULL
          ${opts.partyId ? sql`AND p.party_id = ${opts.partyId}` : sql``}
          AND p.amount_paise - p.tcs_paise - coalesce(s.v, 0) > 0`,
  );
  const parties = await queryRows(
    d,
    tx,
    sql`SELECT id, name, coalesce(gstin, '') AS gstin, coalesce(opening_balance_paise, 0) AS opening
        FROM parties WHERE business_id = ${b} AND deleted_at IS NULL
          ${opts.partyId ? sql`AND id = ${opts.partyId}` : sql``}`,
  );
  const received = new Set<string>(RECEIVABLE_DOCS);
  const creditReceived = new Set<string>(CREDIT_OF_RECEIVED);
  return {
    docs: docs.map((r) => ({
      id: s(r['id']),
      number: r['number'] == null ? null : s(r['number']),
      type: s(r['type']),
      date: s(r['date']),
      dueDate: r['due_date'] == null ? null : s(r['due_date']),
      partyId: r['party_id'] == null ? null : s(r['party_id']),
      partyName: s(r['party']),
      side: received.has(s(r['type'])) ? 'receivable' : 'payable',
      balancePaise: n(r['balance']),
    })),
    credit: [
      ...creditDocs.map((r) => ({
        partyId: s(r['party_id']),
        side: creditReceived.has(s(r['type'])) ? ('receivable' as const) : ('payable' as const),
        paise: n(r['remaining']),
      })),
      ...advances.map((r) => ({
        partyId: s(r['party_id']),
        side: r['direction'] === 'received' ? ('receivable' as const) : ('payable' as const),
        paise: n(r['remaining']),
      })),
    ].filter((c) => c.partyId),
    opening: new Map(
      parties.map((r) => [
        s(r['id']),
        { name: s(r['name']), gstin: s(r['gstin']), paise: n(r['opening']) },
      ]),
    ),
  };
}

const bucketNumbers = (a: AgeingRow): Record<AgeingBucket, number> => ({
  notDue: Number(a.notDue),
  d1_30: Number(a.d1_30),
  d31_60: Number(a.d31_60),
  d61_90: Number(a.d61_90),
  d90plus: Number(a.d90plus),
});

/** The party outstanding rows from balances already read, for one side (or both, net). */
function outstandingRows(
  bal: PartyBalances,
  today: string,
  side: 'all' | 'receivable' | 'payable',
): ReportRow[] {
  interface Acc {
    ageing: AgeingRow;
    credit: bigint;
  }
  const byParty = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = byParty.get(id);
    if (!a) byParty.set(id, (a = { ageing: emptyAgeing(), credit: 0n }));
    return a;
  };
  for (const doc of bal.docs) {
    if (!doc.partyId) continue;
    const signed = BigInt(doc.side === 'receivable' ? doc.balancePaise : -doc.balancePaise);
    ageInto(acc(doc.partyId).ageing, signed, doc.dueDate, doc.date, today);
  }
  for (const c of bal.credit) {
    acc(c.partyId).credit += BigInt(c.side === 'receivable' ? c.paise : -c.paise);
  }
  const flip = side === 'payable' ? -1 : 1;
  const rows: ReportRow[] = [];
  for (const [id, info] of bal.opening) {
    const a = byParty.get(id);
    const ageing = a?.ageing ?? emptyAgeing();
    const docs = AGEING_BUCKETS.reduce((t, k) => t + ageing[k], 0n);
    const credit = a?.credit ?? 0n;
    const outstanding = BigInt(info.paise) + docs - credit;
    if (outstanding === 0n && docs === 0n && credit === 0n) continue;
    if (side !== 'all' && flip * Number(outstanding) <= 0) continue;
    const k = side === 'all' ? 1 : flip;
    const nb = bucketNumbers(ageing);
    rows.push({
      id,
      party: info.name,
      gstin: info.gstin,
      opening: k * info.paise,
      notDue: k * nb.notDue,
      d1_30: k * nb.d1_30,
      d31_60: k * nb.d31_60,
      d61_90: k * nb.d61_90,
      d90plus: k * nb.d90plus,
      credit: k * Number(credit),
      outstanding: k * Number(outstanding),
    });
  }
  rows.sort((x, y) => Math.abs(n(y['outstanding'])) - Math.abs(n(x['outstanding'])));
  return rows;
}

async function partyOutstanding(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
): Promise<ReportResult> {
  const bal = await partyBalancesIn(d, tx, ctx, p.partyId ? { partyId: p.partyId } : {});
  return whole('party_outstanding', outstandingRows(bal, p.today, p.side ?? 'receivable'));
}

async function receivablesPayables(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
): Promise<ReportResult> {
  const bal = await partyBalancesIn(d, tx, ctx);
  const rec = emptyAgeing();
  const pay = emptyAgeing();
  for (const doc of bal.docs) {
    ageInto(
      doc.side === 'receivable' ? rec : pay,
      BigInt(doc.balancePaise),
      doc.dueDate,
      doc.date,
      p.today,
    );
  }
  let creditRec = 0;
  let creditPay = 0;
  for (const c of bal.credit) {
    if (c.side === 'receivable') creditRec += c.paise;
    else creditPay += c.paise;
  }
  let openRec = 0;
  let openPay = 0;
  for (const o of bal.opening.values()) {
    if (o.paise > 0) openRec += o.paise;
    else openPay -= o.paise;
  }
  const rows: ReportRow[] = [
    ...AGEING_BUCKETS.map((k) => ({
      bucket: k,
      receivable: Number(rec[k]),
      payable: Number(pay[k]),
    })),
    { bucket: 'opening', receivable: openRec, payable: openPay },
    { bucket: 'credit', receivable: -creditRec, payable: -creditPay },
  ];
  return whole('receivables_payables', rows);
}

/* ------------------------------------------------------------------ GST */

async function gstSummary(d: Database, tx: any, ctx: Ctx, p: ReportParams): Promise<ReportResult> {
  const inward = p.type === 'inward';
  const plus = inward ? PURCHASE_PLUS : TURNOVER_PLUS;
  const minus = inward ? PURCHASE_MINUS : TURNOVER_MINUS;
  const sg = signOf(minus);
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT d.supply_type AS supply,
               (l.cgst_bp + l.sgst_bp + l.utgst_bp + l.igst_bp) AS rate_bp,
               sum(${sg} * l.taxable_paise) AS taxable, sum(${sg} * l.igst_paise) AS igst,
               sum(${sg} * l.cgst_paise) AS cgst, sum(${sg} * (l.sgst_paise + l.utgst_paise)) AS sgst,
               sum(${sg} * l.cess_paise) AS cess
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE ${docWhere(ctx, untyped(p), [...plus, ...minus])} AND l.deleted_at IS NULL
        GROUP BY d.supply_type, (l.cgst_bp + l.sgst_bp + l.utgst_bp + l.igst_bp)
        ORDER BY d.supply_type, rate_bp`,
  );
  return whole(
    'gst_summary',
    rows.map((r) => {
      const igst = n(r['igst']);
      const cgst = n(r['cgst']);
      const sgst = n(r['sgst']);
      const cess = n(r['cess']);
      return {
        supply: s(r['supply']),
        rate: n(r['rate_bp']),
        taxable: n(r['taxable']),
        igst,
        cgst,
        sgst,
        cess,
        tax: igst + cgst + sgst + cess,
      };
    }),
  );
}

async function hsnSummary(d: Database, tx: any, ctx: Ctx, p: ReportParams): Promise<ReportResult> {
  const sg = signOf(TURNOVER_MINUS);
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT coalesce(l.hsn, '') AS hsn, u.code AS unit_code, u.uqc AS unit_uqc,
               u.is_custom AS is_custom, (l.cgst_bp + l.sgst_bp + l.utgst_bp + l.igst_bp) AS rate_bp,
               sum(${sg} * l.qty_micros) AS qty, sum(${sg} * l.taxable_paise) AS taxable,
               sum(${sg} * l.igst_paise) AS igst, sum(${sg} * l.cgst_paise) AS cgst,
               sum(${sg} * (l.sgst_paise + l.utgst_paise)) AS sgst, sum(${sg} * l.cess_paise) AS cess
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        LEFT JOIN units u ON u.id = l.unit_id
        WHERE ${docWhere(ctx, untyped(p), [...TURNOVER_PLUS, ...TURNOVER_MINUS])} AND l.deleted_at IS NULL
        GROUP BY coalesce(l.hsn, ''), u.code, u.uqc, u.is_custom, (l.cgst_bp + l.sgst_bp + l.utgst_bp + l.igst_bp)`,
  );
  // a name for each code, from the item master (reading every line's text would cost more than the sums)
  const names = new Map<string, string>();
  for (const r of await queryRows(
    d,
    tx,
    sql`SELECT hsn, min(name) AS name FROM items
        WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND hsn IS NOT NULL GROUP BY hsn`,
  )) {
    names.set(s(r['hsn']), s(r['name']));
  }
  // GSTR-1 table 12 reports the UQC, so two units that report the same UQC share a row.
  const merged = new Map<string, ReportRow>();
  for (const r of rows) {
    const uqc = r['unit_code']
      ? returnsUqc({
          code: s(r['unit_code']),
          uqc: r['unit_uqc'] as string | null,
          is_custom: !!r['is_custom'],
        })
      : 'OTH';
    const key = `${s(r['hsn'])}|${uqc}|${n(r['rate_bp'])}`;
    const taxable = n(r['taxable']);
    const igst = n(r['igst']);
    const cgst = n(r['cgst']);
    const sgst = n(r['sgst']);
    const cess = n(r['cess']);
    const cur = merged.get(key);
    if (cur) {
      cur['qty'] = n(cur['qty']) + n(r['qty']);
      cur['taxable'] = n(cur['taxable']) + taxable;
      cur['igst'] = n(cur['igst']) + igst;
      cur['cgst'] = n(cur['cgst']) + cgst;
      cur['sgst'] = n(cur['sgst']) + sgst;
      cur['cess'] = n(cur['cess']) + cess;
      cur['value'] =
        n(cur['taxable']) + n(cur['igst']) + n(cur['cgst']) + n(cur['sgst']) + n(cur['cess']);
    } else {
      merged.set(key, {
        hsn: s(r['hsn']),
        description: names.get(s(r['hsn'])) ?? '',
        uqc,
        qty: n(r['qty']),
        rate: n(r['rate_bp']),
        value: taxable + igst + cgst + sgst + cess,
        taxable,
        igst,
        cgst,
        sgst,
        cess,
      });
    }
  }
  const out = [...merged.values()].sort(
    (a, b) => s(a['hsn']).localeCompare(s(b['hsn'])) || n(a['rate']) - n(b['rate']),
  );
  return whole('hsn_summary', out);
}

/** The trailing digits of a document number, for ordering `INV/9` before `INV/10`. */
const serialOf = (number: string): number => {
  const m = /(\d+)\D*$/.exec(number);
  return m ? Number(m[1]) : -1;
};

async function documentSummary(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
): Promise<ReportResult> {
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT d.type, d.number, d.status, coalesce(ns.series_key, CAST(ns.id AS text), '') AS series_key,
               coalesce(ns.name, ns.prefix, '') AS series_name
        FROM documents d LEFT JOIN number_series ns ON ns.id = d.series_id
        WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status IN ('issued', 'cancelled')
          AND d.number IS NOT NULL
          AND d.type IN (${list(['tax_invoice', 'bill_of_supply', 'debit_note', 'credit_note', 'receipt_voucher', 'delivery_challan'])})
          AND d.date >= ${p.from} AND d.date <= ${p.to}`,
  );
  interface G {
    type: string;
    series: string;
    first: string;
    last: string;
    total: number;
    cancelled: number;
  }
  const groups = new Map<string, G>();
  for (const r of rows) {
    const number = s(r['number']);
    const key = `${s(r['type'])}|${s(r['series_key'])}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        type: s(r['type']),
        series: s(r['series_name']),
        first: number,
        last: number,
        total: 0,
        cancelled: 0,
      };
      groups.set(key, g);
    }
    g.total += 1;
    if (r['status'] === 'cancelled') g.cancelled += 1;
    const a = serialOf(number);
    if (a < serialOf(g.first) || (a === serialOf(g.first) && number < g.first)) g.first = number;
    if (a > serialOf(g.last) || (a === serialOf(g.last) && number > g.last)) g.last = number;
  }
  return whole(
    'document_summary',
    [...groups.values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.series.localeCompare(b.series))
      .map((g) => ({
        type: g.type,
        series: g.series,
        from: g.first,
        to: g.last,
        total: g.total,
        cancelled: g.cancelled,
        net: g.total - g.cancelled,
      })),
  );
}

/* ------------------------------------------------------------------ money */

async function expenseSummary(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
): Promise<ReportResult> {
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT coalesce(nullif(l.description, ''), 'Uncategorised') AS category, count(DISTINCT d.id) AS c,
               sum(l.taxable_paise) AS taxable,
               sum(l.cgst_paise + l.sgst_paise + l.utgst_paise + l.igst_paise + l.cess_paise) AS tax,
               sum(l.total_paise) AS total
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE ${docWhere(ctx, untyped(p), ['expense'])} AND l.deleted_at IS NULL
        GROUP BY coalesce(nullif(l.description, ''), 'Uncategorised') ORDER BY total DESC`,
  );
  return whole(
    'expense_summary',
    rows.map((r) => ({
      category: s(r['category']),
      count: n(r['c']),
      taxable: n(r['taxable']),
      tax: n(r['tax']),
      total: n(r['total']),
    })),
  );
}

async function receiptsPayments(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
  page: ReportPage | undefined,
): Promise<ReportResult> {
  const book =
    p.book === 'cash'
      ? sql`AND p.mode = 'cash'`
      : p.book === 'bank'
        ? sql`AND p.mode <> 'cash'`
        : sql``;
  const where = sql`p.business_id = ${ctx.businessId} AND p.deleted_at IS NULL AND p.status = 'cleared'
    AND p.date >= ${p.from} AND p.date <= ${p.to} ${book}
    ${p.partyId ? sql`AND p.party_id = ${p.partyId}` : sql``}`;
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT p.id, p.date, coalesce(pa.name, '') AS party, p.mode, coalesce(p.reference, '') AS reference,
               CASE WHEN p.direction = 'received' THEN p.amount_paise ELSE 0 END AS receipt,
               CASE WHEN p.direction = 'made' THEN p.amount_paise ELSE 0 END AS payment
        FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id
        WHERE ${where} ORDER BY p.date, p.created_at, p.id ${paging}`,
  );
  const agg = await queryRows(
    d,
    tx,
    sql`SELECT count(*) AS c,
               coalesce(sum(CASE WHEN p.direction = 'received' THEN p.amount_paise ELSE 0 END), 0) AS receipt,
               coalesce(sum(CASE WHEN p.direction = 'made' THEN p.amount_paise ELSE 0 END), 0) AS payment
        FROM payments p WHERE ${where}`,
  );
  const a = agg[0] ?? {};
  return {
    id: 'receipts_payments',
    count: n(a['c']),
    rows: rows.map((r) => ({
      id: s(r['id']),
      date: s(r['date']),
      party: s(r['party']),
      mode: s(r['mode']),
      reference: s(r['reference']),
      receipt: n(r['receipt']),
      payment: n(r['payment']),
    })),
    totals: { receipt: n(a['receipt']), payment: n(a['payment']) },
  };
}

const DAY_BOOK_DOCS = [
  'tax_invoice',
  'bill_of_supply',
  'debit_note',
  'credit_note',
  'purchase_bill',
  'purchase_return',
  'expense',
] as const;

async function dayBook(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
  page: ReportPage | undefined,
): Promise<ReportResult> {
  const b = ctx.businessId;
  const party = p.partyId;
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const both = sql`
    SELECT d.id AS id, d.date AS date, d.type AS kind, coalesce(d.number, '') AS number,
           coalesce(d.party_name, '') AS party, d.total_paise AS amount, d.created_at AS created_at, 1 AS src
    FROM documents d
    WHERE d.business_id = ${b} AND d.deleted_at IS NULL AND d.status = 'issued'
      AND d.type IN (${list(DAY_BOOK_DOCS)}) AND d.date >= ${p.from} AND d.date <= ${p.to}
      ${party ? sql`AND d.party_id = ${party}` : sql``}
    UNION ALL
    SELECT p.id, p.date, CASE WHEN p.direction = 'received' THEN 'receipt' ELSE 'payment' END,
           coalesce(p.reference, ''), coalesce(pa.name, ''), p.amount_paise, p.created_at, 2
    FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id
    WHERE p.business_id = ${b} AND p.deleted_at IS NULL AND p.status = 'cleared'
      AND p.date >= ${p.from} AND p.date <= ${p.to} ${party ? sql`AND p.party_id = ${party}` : sql``}`;
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT * FROM (${both}) t ORDER BY date, created_at, id ${paging}`,
  );
  const cnt = await queryRows(d, tx, sql`SELECT count(*) AS c FROM (${both}) t`);
  return {
    id: 'day_book',
    count: n(cnt[0]?.['c']),
    totals: {},
    rows: rows.map((r) => ({
      id: n(r['src']) === 1 ? s(r['id']) : null,
      date: s(r['date']),
      kind: s(r['kind']),
      number: s(r['number']),
      party: s(r['party']),
      amount: n(r['amount']),
    })),
  };
}

/* ------------------------------------------------------------------ parties and items */

async function partySales(d: Database, tx: any, ctx: Ctx, p: ReportParams): Promise<ReportResult> {
  const one = async (plus: readonly string[], minus: readonly string[]) =>
    queryRows(
      d,
      tx,
      sql`SELECT d.party_id AS pid, coalesce(max(d.party_name), 'Walk-in') AS name, coalesce(max(pa.gstin), '') AS gstin,
                 count(*) AS c, sum(${signOf(minus)} * d.total_taxable_paise) AS v
          FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
          WHERE ${docWhere(ctx, untyped(p), [...plus, ...minus])}
          GROUP BY d.party_id`,
    );
  const sales = await one(TURNOVER_PLUS, TURNOVER_MINUS);
  const purchases = await one(PURCHASE_PLUS, PURCHASE_MINUS);
  const merged = new Map<string, ReportRow>();
  const row = (r: Record<string, any>): ReportRow => {
    const key = r['pid'] == null ? '' : s(r['pid']);
    let x = merged.get(key);
    if (!x) {
      x = {
        id: key || null,
        party: s(r['name']),
        gstin: s(r['gstin']),
        salesCount: 0,
        sales: 0,
        purchaseCount: 0,
        purchases: 0,
      };
      merged.set(key, x);
    }
    return x;
  };
  for (const r of sales) {
    const x = row(r);
    x['salesCount'] = n(r['c']);
    x['sales'] = n(r['v']);
  }
  for (const r of purchases) {
    const x = row(r);
    x['purchaseCount'] = n(r['c']);
    x['purchases'] = n(r['v']);
  }
  const rows = [...merged.values()].sort((a, b) => n(b['sales']) - n(a['sales']));
  return whole('party_sales', rows);
}

async function itemSales(d: Database, tx: any, ctx: Ctx, p: ReportParams): Promise<ReportResult> {
  const sg = signOf(TURNOVER_MINUS);
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT coalesce(max(l.description), '') AS item, coalesce(max(l.hsn), '') AS hsn,
               sum(${sg} * l.qty_micros) AS qty, sum(${sg} * l.taxable_paise) AS taxable,
               sum(${sg} * (l.cgst_paise + l.sgst_paise + l.utgst_paise + l.igst_paise + l.cess_paise)) AS tax,
               sum(${sg} * l.total_paise) AS total
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE ${docWhere(ctx, untyped(p), [...TURNOVER_PLUS, ...TURNOVER_MINUS])} AND l.deleted_at IS NULL
        GROUP BY l.item_id, l.description ORDER BY total DESC`,
  );
  return whole(
    'item_sales',
    rows.map((r) => ({
      item: s(r['item']),
      hsn: s(r['hsn']),
      qty: n(r['qty']),
      taxable: n(r['taxable']),
      tax: n(r['tax']),
      total: n(r['total']),
    })),
  );
}

/* ------------------------------------------------------------------ stock */

export interface StockRow {
  itemId: string;
  item: string;
  sku: string;
  openingMicros: number;
  inMicros: number;
  outMicros: number;
  closingMicros: number;
  minMicros: number;
  /** The purchase price the stock is valued at. */
  ratePaise: number;
  /** Closing quantity at the purchase price. */
  valuePaise: number;
}

/**
 * Stock of every item that tracks it: what it held at the start of the period, what came in and went
 * out, and what is left. Movements are signed, so `out` is shown as a positive amount.
 */
export async function stockRowsIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  from: string,
  to: string,
): Promise<StockRow[]> {
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT i.id, i.name, coalesce(i.sku, '') AS sku, coalesce(i.purchase_rate_paise, 0) AS rate,
               coalesce(i.min_stock_micros, 0) AS min_stock,
               coalesce(m.before_qty, 0) AS before_qty, coalesce(m.qty_in, 0) AS qty_in, coalesce(m.qty_out, 0) AS qty_out
        FROM items i
        LEFT JOIN (
          SELECT item_id,
                 sum(CASE WHEN date < ${from} THEN qty_micros ELSE 0 END) AS before_qty,
                 sum(CASE WHEN date >= ${from} AND qty_micros > 0 THEN qty_micros ELSE 0 END) AS qty_in,
                 sum(CASE WHEN date >= ${from} AND qty_micros < 0 THEN -qty_micros ELSE 0 END) AS qty_out
          FROM stock_movements
          WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND date <= ${to}
          GROUP BY item_id
        ) m ON m.item_id = i.id
        WHERE i.business_id = ${ctx.businessId} AND i.deleted_at IS NULL AND i.track_stock = ${true}
        ORDER BY i.name`,
  );
  return rows.map((r) => {
    // opening stock is itself a movement, so the movements are the whole story
    const opening = n(r['before_qty']);
    const closing = opening + n(r['qty_in']) - n(r['qty_out']);
    return {
      itemId: s(r['id']),
      item: s(r['name']),
      sku: s(r['sku']),
      openingMicros: opening,
      inMicros: n(r['qty_in']),
      outMicros: n(r['qty_out']),
      closingMicros: closing,
      minMicros: n(r['min_stock']),
      ratePaise: n(r['rate']),
      valuePaise: Number(divRound(BigInt(closing) * BigInt(n(r['rate'])), 1_000_000n)),
    };
  });
}

async function stockSummary(
  d: Database,
  tx: any,
  ctx: Ctx,
  p: ReportParams,
): Promise<ReportResult> {
  const all = await stockRowsIn(d, tx, ctx, p.from, p.to);
  const rows =
    p.type === 'low' ? all.filter((r) => r.minMicros > 0 && r.closingMicros < r.minMicros) : all;
  return whole(
    'stock_summary',
    rows.map((r) => ({
      id: r.itemId,
      item: r.item,
      sku: r.sku,
      opening: r.openingMicros,
      in: r.inMicros,
      out: r.outMicros,
      closing: r.closingMicros,
      rate: r.ratePaise,
      value: r.valuePaise,
      min: r.minMicros,
    })),
  );
}

/* ------------------------------------------------------------------ entry points */

/** Run one report. Paged reports return `page.limit` rows from `page.offset`; the rest ignore `page`. */
export async function runReport(
  d: Database,
  ctx: Ctx,
  id: ReportId,
  params: ReportParams,
  page?: ReportPage,
): Promise<ReportResult> {
  return runInTx(d, ctx, async (tx) => {
    switch (id) {
      case 'sales_register':
      case 'purchase_register':
        return register(d, tx, ctx, id, params, page);
      case 'note_register':
        return noteRegister(d, tx, ctx, params, page);
      case 'party_outstanding':
        return partyOutstanding(d, tx, ctx, params);
      case 'receivables_payables':
        return receivablesPayables(d, tx, ctx, params);
      case 'gst_summary':
        return gstSummary(d, tx, ctx, params);
      case 'hsn_summary':
        return hsnSummary(d, tx, ctx, params);
      case 'document_summary':
        return documentSummary(d, tx, ctx, params);
      case 'expense_summary':
        return expenseSummary(d, tx, ctx, params);
      case 'receipts_payments':
        return receiptsPayments(d, tx, ctx, params, page);
      case 'day_book':
        return dayBook(d, tx, ctx, params, page);
      case 'stock_summary':
        return stockSummary(d, tx, ctx, params);
      case 'party_sales':
        return partySales(d, tx, ctx, params);
      case 'item_sales':
        return itemSales(d, tx, ctx, params);
    }
  });
}

/**
 * Every row of a report, in batches, for export. `onBatch` receives each batch as it is read and can
 * stop the export by throwing; memory holds one batch at a time.
 */
export async function exportReport(
  d: Database,
  ctx: Ctx,
  id: ReportId,
  params: ReportParams,
  onBatch: (rows: ReportRow[], totals: Record<string, number>) => void | Promise<void>,
  batch = 5000,
): Promise<number> {
  const def = REPORTS[id];
  if (!def.paged) {
    const r = await runReport(d, ctx, id, params);
    await onBatch(r.rows, r.totals);
    return r.rows.length;
  }
  let offset = 0;
  let sent = 0;
  for (;;) {
    const r = await runReport(d, ctx, id, params, { offset, limit: batch });
    await onBatch(r.rows, r.totals);
    sent += r.rows.length;
    offset += batch;
    if (r.rows.length < batch || sent >= r.count) return sent;
  }
}

/* ------------------------------------------------------------------ dashboard */

export interface DashboardOverdue {
  id: string;
  number: string | null;
  partyId: string | null;
  partyName: string;
  balancePaise: number;
  daysOverdue: number;
}

export interface Dashboard {
  today: string;
  /** Today's issued sales, net of credit notes. */
  salesTodayPaise: number;
  billsToday: number;
  cashReceivedTodayPaise: number;
  /** Cash in hand, from the ledger's Cash account. */
  cashInHandPaise: number;
  topItemsToday: { name: string; qtyMicros: number; taxablePaise: number }[];
  receivablesPaise: number;
  payablesPaise: number;
  receivablesAgeing: Record<AgeingBucket, number>;
  payablesAgeing: Record<AgeingBucket, number>;
  overdue: DashboardOverdue[];
  overdueCount: number;
  overduePaise: number;
  /** Sales so far this month and in the same days of last month. */
  monthSalesPaise: number;
  /** Bills and expenses entered this month, less purchase returns (invoice totals). */
  monthSpendPaise: number;
  lastMonthSalesPaise: number;
  gstEstimate: {
    from: string;
    to: string;
    outputPaise: number;
    inputPaise: number;
    payablePaise: number;
  };
  filing: FilingDue[];
  lowStock: {
    count: number;
    items: { itemId: string; name: string; closingMicros: number; minMicros: number }[];
  };
  drafts: number;
  inbox: number;
  charts: DashboardCharts;
}

export interface MonthPoint {
  /** `YYYY-MM`. */
  month: string;
  salesPaise: number;
  spendPaise: number;
  receiptsPaise: number;
  paymentsPaise: number;
}

/** What the dashboard charts draw. Every figure is the one the matching report shows for the same dates. */
export interface DashboardCharts {
  /**
   * The last date the charts run to: today, or, when nothing was sold in the last six months, the most
   * recent day with a sale, so a quiet book still shows its latest picture instead of an empty chart.
   */
  anchorDate: string;
  anchored: boolean;
  /** Six months ending with the anchor's month, oldest first. */
  months: MonthPoint[];
  /** The 14 days ending on the anchor, oldest first. */
  days: { date: string; salesPaise: number }[];
  /** Top customers by net taxable sales over the six months. */
  topParties: { partyId: string | null; name: string; paise: number }[];
  /** First day of the six-month window. */
  from: string;
}

async function salesBetween(d: Database, tx: any, ctx: Ctx, from: string, to: string) {
  const sg = signOf(TURNOVER_MINUS);
  const p: ReportParams = { from, to, today: to };
  const rows = await queryRows(
    d,
    tx,
    sql`SELECT coalesce(sum(${sg} * d.total_taxable_paise), 0) AS taxable, coalesce(sum(${sg} * d.total_paise), 0) AS total,
               count(CASE WHEN d.type IN ('tax_invoice', 'bill_of_supply') THEN 1 END) AS bills
        FROM documents d WHERE ${docWhere(ctx, p, [...TURNOVER_PLUS, ...TURNOVER_MINUS])}`,
  );
  return {
    taxable: n(rows[0]?.['taxable']),
    total: n(rows[0]?.['total']),
    bills: n(rows[0]?.['bills']),
  };
}

const monthKey = (iso: string) => iso.slice(0, 7);

/** Six month starts ending with the month of `anchor`, oldest first, as `YYYY-MM-01`. */
function lastSixMonthStarts(anchor: string): string[] {
  const y = Number(anchor.slice(0, 4));
  const m = Number(anchor.slice(5, 7));
  const out: string[] = [];
  for (let back = 5; back >= 0; back--) {
    const idx = y * 12 + (m - 1) - back;
    out.push(
      `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}-01`,
    );
  }
  return out;
}

async function chartsIn(d: Database, tx: any, ctx: Ctx, today: string): Promise<DashboardCharts> {
  const b = ctx.businessId;
  // anchor: today when there was a sale in the last six months, else the latest day with one
  const latest = await queryRows(
    d,
    tx,
    sql`SELECT max(d.date) AS v FROM documents d
        WHERE d.business_id = ${b} AND d.deleted_at IS NULL AND d.status = 'issued'
          AND d.type IN (${list(TURNOVER_PLUS)}) AND d.date <= ${today}`,
  );
  const last = latest[0]?.['v'] ? s(latest[0]['v']) : null;
  const anchorDate = last && last < addDays(today, -183) ? last : today;

  const starts = lastSixMonthStarts(anchorDate);
  const from = starts[0]!;
  const months: MonthPoint[] = starts.map((x) => ({
    month: monthKey(x),
    salesPaise: 0,
    spendPaise: 0,
    receiptsPaise: 0,
    paymentsPaise: 0,
  }));
  const at = new Map(months.map((m) => [m.month, m]));
  const span: ReportParams = { from, to: anchorDate, today };
  const MONTH = sql`substr(CAST(d.date AS text), 1, 7)`;

  for (const r of await queryRows(
    d,
    tx,
    sql`SELECT ${MONTH} AS m, sum(${signOf(TURNOVER_MINUS)} * d.total_paise) AS v FROM documents d
        WHERE ${docWhere(ctx, span, [...TURNOVER_PLUS, ...TURNOVER_MINUS])} GROUP BY ${MONTH}`,
  )) {
    const m = at.get(s(r['m']));
    if (m) m.salesPaise = n(r['v']);
  }
  for (const r of await queryRows(
    d,
    tx,
    sql`SELECT ${MONTH} AS m, sum(${signOf(PURCHASE_MINUS)} * d.total_paise) AS v FROM documents d
        WHERE ${docWhere(ctx, span, [...PURCHASE_PLUS, ...PURCHASE_MINUS, 'expense'])} GROUP BY ${MONTH}`,
  )) {
    const m = at.get(s(r['m']));
    if (m) m.spendPaise = n(r['v']);
  }
  const PMONTH = sql`substr(CAST(p.date AS text), 1, 7)`;
  for (const r of await queryRows(
    d,
    tx,
    sql`SELECT ${PMONTH} AS m, p.direction AS dir, sum(p.amount_paise) AS v FROM payments p
        WHERE p.business_id = ${b} AND p.deleted_at IS NULL AND p.status = 'cleared'
          AND p.date >= ${from} AND p.date <= ${anchorDate} GROUP BY ${PMONTH}, p.direction`,
  )) {
    const m = at.get(s(r['m']));
    if (!m) continue;
    if (r['dir'] === 'received') m.receiptsPaise = n(r['v']);
    else m.paymentsPaise = n(r['v']);
  }

  const dayFrom = addDays(anchorDate, -13);
  const daily = new Map<string, number>();
  for (const r of await queryRows(
    d,
    tx,
    sql`SELECT d.date AS day, sum(${signOf(TURNOVER_MINUS)} * d.total_paise) AS v FROM documents d
        WHERE ${docWhere(ctx, { from: dayFrom, to: anchorDate, today }, [...TURNOVER_PLUS, ...TURNOVER_MINUS])}
        GROUP BY d.date`,
  )) {
    daily.set(s(r['day']), n(r['v']));
  }
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(dayFrom, i);
    return { date, salesPaise: daily.get(date) ?? 0 };
  });

  const top = await queryRows(
    d,
    tx,
    sql`SELECT d.party_id AS pid, coalesce(max(d.party_name), '') AS name,
               sum(${signOf(TURNOVER_MINUS)} * d.total_taxable_paise) AS v
        FROM documents d WHERE ${docWhere(ctx, span, [...TURNOVER_PLUS, ...TURNOVER_MINUS])}
        GROUP BY d.party_id ORDER BY v DESC LIMIT 5`,
  );
  return {
    anchorDate,
    anchored: anchorDate !== today,
    from,
    months,
    days,
    topParties: top
      .filter((r) => n(r['v']) > 0)
      .map((r) => ({
        partyId: r['pid'] == null ? null : s(r['pid']),
        name: s(r['name']),
        paise: n(r['v']),
      })),
  };
}

/** Every number on the Shop and Books dashboards in one read, for the caller's `today`. */
export async function getDashboard(d: Database, ctx: Ctx, today: string): Promise<Dashboard> {
  return runInTx(d, ctx, async (tx) => {
    const b = ctx.businessId;
    const day = await salesBetween(d, tx, ctx, today, today);
    const month = resolvePeriod('this_month', today);
    const thisMonth = await salesBetween(d, tx, ctx, month.from, today);
    const last = sameDaysLastMonth({ from: month.from, to: today });
    const lastMonth = await salesBetween(d, tx, ctx, last.from, last.to);

    const cashToday = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(amount_paise), 0) AS v FROM payments
          WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'cleared' AND direction = 'received'
            AND mode = 'cash' AND date = ${today}`,
    );
    const cashLedger = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(e.debit_paise - e.credit_paise), 0) AS v
          FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.business_id = ${b} AND e.deleted_at IS NULL AND a.code = '1000' AND e.date <= ${today}`,
    );
    const top = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(max(l.description), '') AS name, sum(${signOf(TURNOVER_MINUS)} * l.qty_micros) AS qty,
                 sum(${signOf(TURNOVER_MINUS)} * l.taxable_paise) AS taxable
          FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE ${docWhere(ctx, { from: today, to: today, today }, [...TURNOVER_PLUS, ...TURNOVER_MINUS])} AND l.deleted_at IS NULL
          GROUP BY l.item_id, l.description ORDER BY taxable DESC LIMIT 5`,
    );

    const bal = await partyBalancesIn(d, tx, ctx);
    const overdue: DashboardOverdue[] = [];
    let overduePaise = 0;
    for (const doc of bal.docs) {
      if (doc.side !== 'receivable') continue;
      const late = daysPastDue(doc.dueDate, doc.date, today);
      if (doc.balancePaise > 0 && late > 0) {
        overduePaise += doc.balancePaise;
        overdue.push({
          id: doc.id,
          number: doc.number,
          partyId: doc.partyId,
          partyName: doc.partyName,
          balancePaise: doc.balancePaise,
          daysOverdue: late,
        });
      }
    }
    // the same rows the Party outstanding report shows, so each number equals the report it opens
    const recRows = outstandingRows(bal, today, 'receivable');
    const payRows = outstandingRows(bal, today, 'payable');
    const sumOf = (rows: ReportRow[], key: string) => rows.reduce((acc, r) => acc + n(r[key]), 0);
    const ageingOf = (rows: ReportRow[]): Record<AgeingBucket, number> => ({
      notDue: sumOf(rows, 'notDue'),
      d1_30: sumOf(rows, 'd1_30'),
      d31_60: sumOf(rows, 'd31_60'),
      d61_90: sumOf(rows, 'd61_90'),
      d90plus: sumOf(rows, 'd90plus'),
    });
    overdue.sort((x, y) => y.daysOverdue - x.daysOverdue || y.balancePaise - x.balancePaise);

    // GST payable estimate for this month: tax on sales less tax on purchases (input credit)
    const taxSum = (minus: readonly string[]) =>
      sql`coalesce(sum(${signOf(minus)} * (d.total_cgst_paise + d.total_sgst_paise + d.total_utgst_paise + d.total_igst_paise + d.total_cess_paise)), 0)`;
    const output = await queryRows(
      d,
      tx,
      sql`SELECT ${taxSum(TURNOVER_MINUS)} AS v FROM documents d WHERE ${docWhere(ctx, { from: month.from, to: month.to, today }, [...TURNOVER_PLUS, ...TURNOVER_MINUS])}`,
    );
    const input = await queryRows(
      d,
      tx,
      sql`SELECT ${taxSum(PURCHASE_MINUS)} AS v FROM documents d WHERE ${docWhere(ctx, { from: month.from, to: month.to, today }, [...PURCHASE_PLUS, ...PURCHASE_MINUS])}`,
    );

    const spend = await queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(${signOf(PURCHASE_MINUS)} * d.total_paise), 0) AS v FROM documents d
          WHERE ${docWhere(ctx, { from: month.from, to: today, today }, [...PURCHASE_PLUS, ...PURCHASE_MINUS, 'expense'])}`,
    );
    const stock = await stockRowsIn(d, tx, ctx, today, today);
    const low = stock.filter((r) => r.minMicros > 0 && r.closingMicros < r.minMicros);

    const counts = await queryRows(
      d,
      tx,
      sql`SELECT (SELECT count(*) FROM documents WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'draft') AS drafts,
                 (SELECT count(*) FROM review_items WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'pending') AS inbox`,
    );
    const outputPaise = n(output[0]?.['v']);
    const inputPaise = n(input[0]?.['v']);
    return {
      today,
      salesTodayPaise: day.total,
      billsToday: day.bills,
      cashReceivedTodayPaise: n(cashToday[0]?.['v']),
      cashInHandPaise: n(cashLedger[0]?.['v']),
      topItemsToday: top.map((r) => ({
        name: s(r['name']),
        qtyMicros: n(r['qty']),
        taxablePaise: n(r['taxable']),
      })),
      receivablesPaise: sumOf(recRows, 'outstanding'),
      payablesPaise: sumOf(payRows, 'outstanding'),
      receivablesAgeing: ageingOf(recRows),
      payablesAgeing: ageingOf(payRows),
      overdue: overdue.slice(0, 5),
      overdueCount: overdue.length,
      overduePaise,
      monthSalesPaise: thisMonth.total,
      monthSpendPaise: n(spend[0]?.['v']),
      lastMonthSalesPaise: lastMonth.total,
      gstEstimate: {
        from: month.from,
        to: month.to,
        outputPaise,
        inputPaise,
        payablePaise: outputPaise - inputPaise,
      },
      filing: filingCalendar(today),
      lowStock: {
        count: low.length,
        items: low.slice(0, 5).map((r) => ({
          itemId: r.itemId,
          name: r.item,
          closingMicros: r.closingMicros,
          minMicros: r.minMicros,
        })),
      },
      drafts: n(counts[0]?.['drafts']),
      inbox: n(counts[0]?.['inbox']),
      charts: await chartsIn(d, tx, ctx, today),
    };
  });
}
