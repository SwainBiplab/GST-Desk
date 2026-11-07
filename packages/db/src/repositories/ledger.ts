/**
 * The ledger as a person sees it (prompt 50): the chart of accounts, journal vouchers (hand-made entries,
 * contras, opening balances, the year-end close and its reversal), recurring journals, the financial
 * statements over the entries every document and payment has posted since Phase 1, and the checks that the
 * postings are whole and tie to the sub-ledgers. The arithmetic lives in `@gst/domain/ledger`; this reads and
 * writes. Every write is one transaction, balanced before it starts, and refused inside a locked or closed
 * period unless an owner says why.
 */
import {
  POSTS_TO_LEDGER,
  balanceSheet,
  cashFlow,
  closingEntries,
  financialYear,
  fyOf,
  postDocument,
  postPayment,
  profitAndLoss,
  runningBalances,
  trialBalance,
  type AccountKey,
  type AccountSums,
  type BalanceSheet,
  type CashFlow,
  type DocumentType,
  type ProfitAndLoss,
  type TrialBalance,
} from '@gst/domain';
import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import { BusinessRepo, SettingsRepo } from './aggregates';
import { BaseRepo, RuleError, newId, runInTx, writeAudit, type Ctx } from './base';
import { ACCOUNTS, ChartRepo, LEGACY_TAX_ACCOUNTS, type ChartAccount } from './chart';
import { DocumentFlowRepo } from './document-flow';
import { PaymentFlowRepo } from './payment-flow';
import { PeriodLockRepo, type LockOverride } from './period-lock';

/* ------------------------------------------------------------------------------------ shapes */

export interface VoucherLineInput {
  accountId: string;
  debitPaise: bigint;
  creditPaise: bigint;
  partyId?: string | null;
  narration?: string | null;
}

export type VoucherKind =
  'journal' | 'contra' | 'opening' | 'closing' | 'reversal' | 'recurring' | 'reclass';

export interface VoucherInput {
  date: string;
  kind?: VoucherKind;
  narration?: string | null;
  lines: VoucherLineInput[];
  lockOverride?: LockOverride;
}

export interface VoucherLine {
  id: string;
  accountId: string;
  code: string;
  name: string;
  debitPaise: bigint;
  creditPaise: bigint;
  partyId: string | null;
  narration: string | null;
}

export interface Voucher {
  id: string;
  number: string;
  date: string;
  kind: VoucherKind;
  narration: string | null;
  status: 'posted' | 'reversed';
  reversedBy: string | null;
  reverses: string | null;
  recurringId: string | null;
  totalPaise: bigint;
  version: number;
  lines: VoucherLine[];
}

export interface Span {
  from: string;
  to: string;
}

export interface StatementRow {
  id: string;
  date: string;
  debitPaise: bigint;
  creditPaise: bigint;
  balancePaise: bigint;
  narration: string | null;
  partyId: string | null;
  source:
    | {
        kind: 'document';
        id: string;
        number: string | null;
        type: string;
        partyName: string | null;
      }
    | { kind: 'payment'; id: string; reference: string | null; mode: string; direction: string }
    | { kind: 'voucher'; id: string; number: string; voucherKind: string }
    | { kind: 'other' };
}

export interface AccountStatement {
  account: ChartAccount;
  openingPaise: bigint;
  rows: StatementRow[];
  closingPaise: bigint;
  debitPaise: bigint;
  creditPaise: bigint;
}

export interface DayBookEntry {
  date: string;
  source: StatementRow['source'];
  narration: string | null;
  lines: { code: string; name: string; debitPaise: bigint; creditPaise: bigint }[];
  totalPaise: bigint;
}

export interface FiscalYearView {
  fyStart: string;
  fyEnd: string;
  label: string;
  status: 'open' | 'closed';
  closedAt: number | null;
  closedBy: string | null;
  closingVoucherId: string | null;
  reopenedAt: number | null;
  reopenReason: string | null;
  /** Entries dated inside the year. */
  entries: number;
}

export interface LedgerVerification {
  documents: { checked: number; missing: string[]; unbalanced: string[] };
  payments: { checked: number; missing: string[] };
  /** The receivables and payables control accounts against the parties' positions, net. */
  control: {
    ledgerNetPaise: bigint;
    partiesNetPaise: bigint;
    differencePaise: bigint;
    receivablesLedgerPaise: bigint;
    payablesLedgerPaise: bigint;
  };
  /** Balances still on the pre-prompt-50 aggregate tax ledgers. */
  legacyTax: { outputPaise: bigint; inputPaise: bigint };
  vouchers: { checked: number; unbalanced: string[] };
}

export interface RecurringJournal {
  id: string;
  name: string;
  every: 'monthly' | 'quarterly' | 'yearly';
  day: number;
  nextDate: string;
  endDate: string | null;
  lines: VoucherLineInput[];
  narration: string | null;
  active: boolean;
  lastPostedDate: string | null;
  version: number;
}

const big = (v: unknown) => BigInt(Math.trunc(Number(v ?? 0)));
const num = (v: bigint) => Number(v);
const PREFIX: Record<VoucherKind, string> = {
  journal: 'JV',
  contra: 'CV',
  opening: 'OB',
  closing: 'CL',
  reversal: 'RV',
  recurring: 'RJ',
  reclass: 'RC',
};

/* ------------------------------------------------------------------------------------ sums */

/** Debit and credit per account over a span of dates, optionally without the year-end vouchers. */
async function sumsIn(
  d: Database,
  tx: any,
  ctx: Ctx,
  span: { from?: string | undefined; to?: string | undefined },
  opts: { excludeVoucherIds?: string[] } = {},
): Promise<AccountSums[]> {
  const t = d.schema.ledger_entries;
  const rows: Row[] = await tx
    .select({
      account_id: t.account_id,
      debit: sql<number>`coalesce(sum(${t.debit_paise}), 0)`,
      credit: sql<number>`coalesce(sum(${t.credit_paise}), 0)`,
    })
    .from(t)
    .where(
      and(
        eq(t.business_id, ctx.businessId),
        isNull(t.deleted_at),
        span.from ? gte(t.date, span.from) : undefined,
        span.to ? lte(t.date, span.to) : undefined,
        opts.excludeVoucherIds?.length
          ? sql`(${t.voucher_id} IS NULL OR ${notInArray(t.voucher_id, opts.excludeVoucherIds)})`
          : undefined,
      ),
    )
    .groupBy(t.account_id);
  return rows.map((r) => ({
    accountId: String(r['account_id']),
    debitPaise: big(r['debit']),
    creditPaise: big(r['credit']),
  }));
}

/** The year-end vouchers and their reversals: left out of the profit and loss and the cash flow. */
async function closingVoucherIdsIn(d: Database, tx: any, ctx: Ctx): Promise<string[]> {
  const v = d.schema.journal_vouchers;
  const rows: Row[] = await tx
    .select({ id: v.id, reversed_by: v.reversed_by })
    .from(v)
    .where(and(eq(v.business_id, ctx.businessId), eq(v.kind, 'closing'), isNull(v.deleted_at)));
  const ids: string[] = [];
  for (const r of rows) {
    ids.push(String(r['id']));
    if (r['reversed_by']) ids.push(String(r['reversed_by']));
  }
  return ids;
}

const dayBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/* --------------------------------------------------------------------------------- vouchers */

export class JournalRepo extends BaseRepo {
  private readonly entries: BaseRepo;
  private readonly chart: ChartRepo;
  private readonly lock: PeriodLockRepo;
  private readonly settings: SettingsRepo;

  constructor(d: Database) {
    super(d, 'journal_vouchers');
    this.entries = new BaseRepo(d, 'ledger_entries');
    this.chart = new ChartRepo(d);
    this.lock = new PeriodLockRepo(d);
    this.settings = new SettingsRepo(d);
  }

  private async fyStartMonthIn(tx: any, ctx: Ctx): Promise<number> {
    const b = await new BusinessRepo(this.d).get({ ...ctx, tx });
    return Number(b?.['fy_start_month'] ?? 4);
  }

  /** `JV/25-26/0001`: one counter per kind and financial year, kept in settings. */
  private async nextNumberIn(tx: any, ctx: Ctx, kind: VoucherKind, date: string): Promise<string> {
    const c: Ctx = { ...ctx, tx };
    const fy = fyOf(date, await this.fyStartMonthIn(tx, ctx));
    const key = `ledger.number.${PREFIX[kind]}.${fy.label}`;
    const n = Number((await this.settings.getValue<number>(c, key)) ?? 0) + 1;
    await this.settings.set(c, key, n);
    return `${PREFIX[kind]}/${fy.label}/${String(n).padStart(4, '0')}`;
  }

  private async assertYearOpenIn(
    tx: any,
    ctx: Ctx,
    date: string,
    kind: VoucherKind,
  ): Promise<void> {
    if (kind === 'closing' || kind === 'reversal') return;
    const fy = fyOf(date, await this.fyStartMonthIn(tx, ctx));
    const t = this.d.schema.fiscal_years;
    const [row]: Row[] = await tx
      .select({ status: t.status })
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), eq(t.fy_start, fy.start), isNull(t.deleted_at)))
      .limit(1);
    if (row && row['status'] === 'closed')
      throw new RuleError(`The year ${fy.label} is closed. Reopen it first (an owner can).`);
  }

  async post(
    ctx: Ctx,
    input: VoucherInput,
    extra: { recurringId?: string | null; reverses?: string | null } = {},
  ): Promise<Voucher> {
    const kind = input.kind ?? 'journal';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new RuleError('The voucher needs a date.');
    const lines = input.lines.filter((l) => l.debitPaise !== 0n || l.creditPaise !== 0n);
    if (lines.length < 2) throw new RuleError('A voucher needs at least two lines.');
    let dr = 0n;
    let cr = 0n;
    for (const l of lines) {
      if (l.debitPaise < 0n || l.creditPaise < 0n)
        throw new RuleError('Amounts cannot be negative.');
      if (l.debitPaise > 0n === l.creditPaise > 0n)
        throw new RuleError('Each line is a debit or a credit, not both.');
      dr += l.debitPaise;
      cr += l.creditPaise;
    }
    if (dr !== cr)
      throw new RuleError(`The voucher does not balance: debits ${dr} and credits ${cr} differ.`);
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const accounts = new Map((await this.chart.accountsIn(tx, ctx)).map((a) => [a.id, a]));
      for (const l of lines)
        if (!accounts.has(l.accountId))
          throw new RuleError('A line names an account that does not exist.');
      const id = newId();
      await this.lock.assertOpen(
        c,
        input.date,
        { action: `journal:${kind}`, documentId: id },
        input.lockOverride,
      );
      await this.assertYearOpenIn(tx, ctx, input.date, kind);
      const number = await this.nextNumberIn(tx, ctx, kind, input.date);
      const row = await this.createIn(tx, ctx, {
        id,
        number,
        date: input.date,
        kind,
        narration: input.narration?.trim() || null,
        status: 'posted',
        recurring_id: extra.recurringId ?? null,
        reverses: extra.reverses ?? null,
        total_paise: num(dr),
      });
      for (const l of lines)
        await (this.entries as any).createIn(tx, ctx, {
          voucher_id: id,
          account_id: l.accountId,
          party_id: l.partyId ?? null,
          debit_paise: num(l.debitPaise),
          credit_paise: num(l.creditPaise),
          date: input.date,
          narration: l.narration?.trim() || input.narration?.trim() || null,
        });
      return (await this.getIn(tx, ctx, String(row['id'])).then((r) =>
        this.voucherIn(tx, ctx, r!),
      ))!;
    });
  }

  private async voucherIn(tx: any, ctx: Ctx, row: Row): Promise<Voucher> {
    const le = this.d.schema.ledger_entries;
    const la = this.d.schema.ledger_accounts;
    const lines: Row[] = await tx
      .select({
        id: le.id,
        account_id: le.account_id,
        code: la.code,
        name: la.name,
        debit_paise: le.debit_paise,
        credit_paise: le.credit_paise,
        party_id: le.party_id,
        narration: le.narration,
      })
      .from(le)
      .innerJoin(la, eq(la.id, le.account_id))
      .where(
        and(
          eq(le.business_id, ctx.businessId),
          eq(le.voucher_id, row['id']),
          isNull(le.deleted_at),
        ),
      )
      .orderBy(desc(le.debit_paise), asc(la.code));
    return {
      id: String(row['id']),
      number: String(row['number']),
      date: String(row['date']),
      kind: String(row['kind']) as VoucherKind,
      narration: (row['narration'] as string | null) ?? null,
      status: String(row['status']) as 'posted' | 'reversed',
      reversedBy: (row['reversed_by'] as string | null) ?? null,
      reverses: (row['reverses'] as string | null) ?? null,
      recurringId: (row['recurring_id'] as string | null) ?? null,
      totalPaise: big(row['total_paise']),
      version: Number(row['version'] ?? 1),
      lines: lines.map((l) => ({
        id: String(l['id']),
        accountId: String(l['account_id']),
        code: String(l['code']),
        name: String(l['name']),
        debitPaise: big(l['debit_paise']),
        creditPaise: big(l['credit_paise']),
        partyId: (l['party_id'] as string | null) ?? null,
        narration: (l['narration'] as string | null) ?? null,
      })),
    };
  }

  async voucher(ctx: Ctx, id: string): Promise<Voucher | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const row = await this.getIn(tx, ctx, id);
      return row ? this.voucherIn(tx, ctx, row) : null;
    });
  }

  async vouchers(
    ctx: Ctx,
    span: Partial<Span> & { kind?: VoucherKind | undefined; limit?: number } = {},
  ): Promise<Voucher[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const rows: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            isNull(t.deleted_at),
            span.from ? gte(t.date, span.from) : undefined,
            span.to ? lte(t.date, span.to) : undefined,
            span.kind ? eq(t.kind, span.kind) : undefined,
          ),
        )
        .orderBy(desc(t.date), desc(t.created_at))
        .limit(span.limit ?? 500);
      const out: Voucher[] = [];
      for (const r of rows) out.push(await this.voucherIn(tx, ctx, r));
      return out;
    });
  }

  /** A voucher is never edited: it is reversed by an equal and opposite one, and both stay. */
  async reverse(
    ctx: Ctx,
    id: string,
    reason: string,
    date?: string,
    lockOverride?: LockOverride,
  ): Promise<Voucher> {
    if (!reason.trim()) throw new RuleError('Say why the voucher is being reversed.');
    return runInTx(this.d, ctx, async (tx) => {
      const row = await this.getIn(tx, ctx, id);
      if (!row) throw new RuleError('That voucher was not found.');
      if (row['status'] === 'reversed') throw new RuleError('That voucher is already reversed.');
      const v = await this.voucherIn(tx, ctx, row);
      const c: Ctx = { ...ctx, tx };
      const made = await this.post(
        c,
        {
          date: date ?? v.date,
          kind: 'reversal',
          narration: `Reversal of ${v.number}: ${reason.trim()}`,
          lines: v.lines.map((l) => ({
            accountId: l.accountId,
            debitPaise: l.creditPaise,
            creditPaise: l.debitPaise,
            partyId: l.partyId,
          })),
          ...(lockOverride ? { lockOverride } : {}),
        },
        { reverses: v.id },
      );
      await this.updateIn(tx, ctx, v.id, { status: 'reversed', reversed_by: made.id }, v.version);
      return made;
    });
  }

  /**
   * Opening balances per account as at the first day of a year (prompt 50): one `opening` voucher per year,
   * replaced by reversing the earlier one. Lines that do not balance are balanced through Opening Balance
   * Equity, as a first year's openings always are.
   */
  async setOpening(
    ctx: Ctx,
    fyStart: string,
    lines: VoucherLineInput[],
    lockOverride?: LockOverride,
  ): Promise<Voucher> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const t = this.t;
      const [prior]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            eq(t.kind, 'opening'),
            eq(t.date, fyStart),
            eq(t.status, 'posted'),
            isNull(t.deleted_at),
          ),
        )
        .limit(1);
      if (prior)
        await this.reverse(
          c,
          String(prior['id']),
          'Opening balances entered again',
          fyStart,
          lockOverride,
        );
      const flow = new DocumentFlowRepo(this.d);
      const equity = await flow.accountIdIn(tx, ctx, 'openingEquity');
      const dr = lines.reduce((a, l) => a + l.debitPaise, 0n);
      const cr = lines.reduce((a, l) => a + l.creditPaise, 0n);
      const balanced = [...lines.filter((l) => l.accountId !== equity)];
      const eq0 = lines.find((l) => l.accountId === equity);
      const net = dr - cr - (eq0 ? eq0.debitPaise - eq0.creditPaise : 0n); // debit surplus to balance
      if (net !== 0n)
        balanced.push({
          accountId: equity,
          debitPaise: net < 0n ? -net : 0n,
          creditPaise: net > 0n ? net : 0n,
        });
      return this.post(c, {
        date: fyStart,
        kind: 'opening',
        narration: 'Opening balances',
        lines: balanced,
        ...(lockOverride ? { lockOverride } : {}),
      });
    });
  }
}

/* ------------------------------------------------------------------------------- recurring */

const addMonths = (iso: string, months: number, day: number): string => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
const STEP: Record<RecurringJournal['every'], number> = { monthly: 1, quarterly: 3, yearly: 12 };

export class RecurringJournalRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'recurring_journals');
  }

  private view(r: Row): RecurringJournal {
    const lines = (
      (r['lines_json'] ?? []) as {
        accountId: string;
        debitPaise: string | number;
        creditPaise: string | number;
        partyId?: string | null;
      }[]
    ).map((l) => ({
      accountId: l.accountId,
      debitPaise: big(l.debitPaise),
      creditPaise: big(l.creditPaise),
      partyId: l.partyId ?? null,
    }));
    return {
      id: String(r['id']),
      name: String(r['name']),
      every: String(r['every']) as RecurringJournal['every'],
      day: Number(r['day'] ?? 1),
      nextDate: String(r['next_date']),
      endDate: (r['end_date'] as string | null) ?? null,
      lines,
      narration: (r['narration'] as string | null) ?? null,
      active: !!r['active'],
      lastPostedDate: (r['last_posted_date'] as string | null) ?? null,
      version: Number(r['version'] ?? 1),
    };
  }

  private static linesJson(lines: VoucherLineInput[]) {
    let dr = 0n;
    let cr = 0n;
    for (const l of lines) {
      dr += l.debitPaise;
      cr += l.creditPaise;
    }
    if (lines.length < 2 || dr !== cr || dr === 0n)
      throw new RuleError('A recurring journal needs balanced lines.');
    return lines.map((l) => ({
      accountId: l.accountId,
      debitPaise: String(l.debitPaise),
      creditPaise: String(l.creditPaise),
      partyId: l.partyId ?? null,
    }));
  }

  async all(ctx: Ctx): Promise<RecurringJournal[]> {
    return (await this.list(ctx)).map((r) => this.view(r));
  }

  async createRecurring(
    ctx: Ctx,
    input: {
      name: string;
      every: RecurringJournal['every'];
      day: number;
      startDate: string;
      endDate?: string | null;
      lines: VoucherLineInput[];
      narration?: string | null;
    },
  ): Promise<RecurringJournal> {
    if (!input.name.trim()) throw new RuleError('A recurring journal needs a name.');
    const day = Math.max(1, Math.min(31, Math.trunc(input.day)));
    const row = await this.create(ctx, {
      name: input.name.trim(),
      every: input.every,
      day,
      next_date: input.startDate,
      end_date: input.endDate ?? null,
      lines_json: RecurringJournalRepo.linesJson(input.lines),
      narration: input.narration?.trim() || null,
      active: true,
    });
    return this.view(row);
  }

  async updateRecurring(
    ctx: Ctx,
    id: string,
    patch: Partial<{
      name: string;
      active: boolean;
      endDate: string | null;
      lines: VoucherLineInput[];
      narration: string | null;
      nextDate: string;
    }>,
    version: number,
  ): Promise<RecurringJournal> {
    const values: NewRow = {};
    if (patch.name !== undefined) values['name'] = patch.name.trim();
    if (patch.active !== undefined) values['active'] = patch.active;
    if (patch.endDate !== undefined) values['end_date'] = patch.endDate;
    if (patch.lines !== undefined)
      values['lines_json'] = RecurringJournalRepo.linesJson(patch.lines);
    if (patch.narration !== undefined) values['narration'] = patch.narration?.trim() || null;
    if (patch.nextDate !== undefined) values['next_date'] = patch.nextDate;
    return this.view(await this.update(ctx, id, values, version));
  }

  /**
   * Post every journal that is due on or before `today`, one voucher per schedule date, never twice for the
   * same date (a voucher already carries the template and the date). At most 36 per template per run.
   */
  async postDue(ctx: Ctx, today: string): Promise<{ posted: number; vouchers: string[] }> {
    const journal = new JournalRepo(this.d);
    let posted = 0;
    const vouchers: string[] = [];
    for (const r of await this.all(ctx)) {
      if (!r.active) continue;
      let next = r.nextDate;
      let version = r.version;
      for (let i = 0; i < 36 && next <= today && (!r.endDate || next <= r.endDate); i++) {
        const already = await runInTx(this.d, ctx, async (tx) => {
          const v = this.d.schema.journal_vouchers;
          const [row]: Row[] = await tx
            .select({ id: v.id })
            .from(v)
            .where(
              and(
                eq(v.business_id, ctx.businessId),
                eq(v.recurring_id, r.id),
                eq(v.date, next),
                isNull(v.deleted_at),
              ),
            )
            .limit(1);
          return row ? String(row['id']) : null;
        });
        if (!already) {
          const v = await journal.post(
            ctx,
            { date: next, kind: 'recurring', narration: r.narration ?? r.name, lines: r.lines },
            { recurringId: r.id },
          );
          vouchers.push(v.id);
          posted++;
        }
        const after = addMonths(next, STEP[r.every], r.day);
        const row = await this.update(
          ctx,
          r.id,
          { next_date: after, last_posted_date: next },
          version,
        );
        version = Number(row['version']);
        next = after;
      }
    }
    return { posted, vouchers };
  }
}

/* ----------------------------------------------------------------------------- statements */

export class LedgerReports {
  private readonly chart: ChartRepo;

  constructor(private readonly d: Database) {
    this.chart = new ChartRepo(d);
  }

  async trialBalance(ctx: Ctx, span: Span): Promise<TrialBalance> {
    return runInTx(this.d, ctx, async (tx) => {
      const accounts = await this.chart.accountsIn(tx, ctx);
      const opening = await sumsIn(this.d, tx, ctx, { to: dayBefore(span.from) });
      const period = await sumsIn(this.d, tx, ctx, span);
      return trialBalance(accounts, opening, period);
    });
  }

  async statement(ctx: Ctx, accountId: string, span: Span): Promise<AccountStatement> {
    return runInTx(this.d, ctx, async (tx) => {
      const account = (await this.chart.accountsIn(tx, ctx)).find((a) => a.id === accountId);
      if (!account) throw new RuleError('That account was not found.');
      const [op] = await sumsIn(this.d, tx, ctx, { to: dayBefore(span.from) }).then((s) =>
        s.filter((x) => x.accountId === accountId),
      );
      const openingPaise = op
        ? account.type === 'asset' || account.type === 'expense'
          ? op.debitPaise - op.creditPaise
          : op.creditPaise - op.debitPaise
        : 0n;
      const le = this.d.schema.ledger_entries;
      const rows: Row[] = await tx
        .select()
        .from(le)
        .where(
          and(
            eq(le.business_id, ctx.businessId),
            eq(le.account_id, accountId),
            isNull(le.deleted_at),
            gte(le.date, span.from),
            lte(le.date, span.to),
          ),
        )
        .orderBy(asc(le.date), asc(le.created_at));
      const sources = await this.sourcesIn(tx, ctx, rows);
      const entries = rows.map((r) => ({
        id: String(r['id']),
        date: String(r['date']),
        debitPaise: big(r['debit_paise']),
        creditPaise: big(r['credit_paise']),
        narration: (r['narration'] as string | null) ?? null,
        partyId: (r['party_id'] as string | null) ?? null,
        source: sources.get(String(r['id'])) ?? ({ kind: 'other' } as const),
      }));
      const withBalances = runningBalances(account.type, openingPaise, entries);
      return {
        account,
        openingPaise,
        rows: withBalances,
        closingPaise: withBalances.at(-1)?.balancePaise ?? openingPaise,
        debitPaise: entries.reduce((a, e) => a + e.debitPaise, 0n),
        creditPaise: entries.reduce((a, e) => a + e.creditPaise, 0n),
      };
    });
  }

  /** What each entry came from: its document, payment or voucher. */
  private async sourcesIn(
    tx: any,
    ctx: Ctx,
    rows: Row[],
  ): Promise<Map<string, StatementRow['source']>> {
    const out = new Map<string, StatementRow['source']>();
    const docIds = [...new Set(rows.map((r) => r['document_id']).filter((x): x is string => !!x))];
    const payIds = [...new Set(rows.map((r) => r['payment_id']).filter((x): x is string => !!x))];
    const vouIds = [...new Set(rows.map((r) => r['voucher_id']).filter((x): x is string => !!x))];
    const docs = new Map<string, Row>();
    const pays = new Map<string, Row>();
    const vous = new Map<string, Row>();
    const chunk = async (ids: string[], table: any, into: Map<string, Row>) => {
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200);
        const got: Row[] = await tx
          .select()
          .from(table)
          .where(and(eq(table.business_id, ctx.businessId), inArray(table.id, part)));
        for (const g of got) into.set(String(g['id']), g);
      }
    };
    await chunk(docIds, this.d.schema.documents, docs);
    await chunk(payIds, this.d.schema.payments, pays);
    await chunk(vouIds, this.d.schema.journal_vouchers, vous);
    for (const r of rows) {
      const id = String(r['id']);
      const d = r['document_id'] ? docs.get(String(r['document_id'])) : undefined;
      const p = r['payment_id'] ? pays.get(String(r['payment_id'])) : undefined;
      const v = r['voucher_id'] ? vous.get(String(r['voucher_id'])) : undefined;
      if (d)
        out.set(id, {
          kind: 'document',
          id: String(d['id']),
          number: (d['number'] as string | null) ?? null,
          type: String(d['type']),
          partyName: (d['party_name'] as string | null) ?? null,
        });
      else if (p)
        out.set(id, {
          kind: 'payment',
          id: String(p['id']),
          reference: (p['reference'] as string | null) ?? null,
          mode: String(p['mode']),
          direction: String(p['direction']),
        });
      else if (v)
        out.set(id, {
          kind: 'voucher',
          id: String(v['id']),
          number: String(v['number']),
          voucherKind: String(v['kind']),
        });
      else out.set(id, { kind: 'other' });
    }
    return out;
  }

  async profitAndLoss(ctx: Ctx, span: Span, compare?: Span): Promise<ProfitAndLoss> {
    return runInTx(this.d, ctx, async (tx) => {
      const accounts = await this.chart.accountsIn(tx, ctx);
      const excludeVoucherIds = await closingVoucherIdsIn(this.d, tx, ctx);
      const period = await sumsIn(this.d, tx, ctx, span, { excludeVoucherIds });
      const cmp = compare ? await sumsIn(this.d, tx, ctx, compare, { excludeVoucherIds }) : null;
      return profitAndLoss(accounts, period, cmp);
    });
  }

  async balanceSheet(ctx: Ctx, asAt: string, compareAsAt?: string): Promise<BalanceSheet> {
    return runInTx(this.d, ctx, async (tx) => {
      const accounts = await this.chart.accountsIn(tx, ctx);
      const now = await sumsIn(this.d, tx, ctx, { to: asAt });
      const cmp = compareAsAt ? await sumsIn(this.d, tx, ctx, { to: compareAsAt }) : null;
      return balanceSheet(accounts, now, cmp);
    });
  }

  async cashFlow(ctx: Ctx, span: Span): Promise<CashFlow> {
    return runInTx(this.d, ctx, async (tx) => {
      const accounts = await this.chart.accountsIn(tx, ctx);
      const excludeVoucherIds = await closingVoucherIdsIn(this.d, tx, ctx);
      const period = await sumsIn(this.d, tx, ctx, span, { excludeVoucherIds });
      const opening = await sumsIn(this.d, tx, ctx, { to: dayBefore(span.from) });
      return cashFlow(accounts, period, opening);
    });
  }

  /** Every posting in the span, grouped by what made it, newest day first. */
  async dayBook(ctx: Ctx, span: Span, limit = 2000): Promise<DayBookEntry[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const le = this.d.schema.ledger_entries;
      const la = this.d.schema.ledger_accounts;
      const rows: Row[] = await tx
        .select({
          id: le.id,
          date: le.date,
          document_id: le.document_id,
          payment_id: le.payment_id,
          voucher_id: le.voucher_id,
          narration: le.narration,
          debit_paise: le.debit_paise,
          credit_paise: le.credit_paise,
          code: la.code,
          name: la.name,
          created_at: le.created_at,
        })
        .from(le)
        .innerJoin(la, eq(la.id, le.account_id))
        .where(
          and(
            eq(le.business_id, ctx.businessId),
            isNull(le.deleted_at),
            gte(le.date, span.from),
            lte(le.date, span.to),
          ),
        )
        .orderBy(desc(le.date), asc(le.created_at))
        .limit(limit);
      const sources = await this.sourcesIn(tx, ctx, rows);
      const groups = new Map<string, DayBookEntry>();
      for (const r of rows) {
        const key = String(r['document_id'] ?? r['payment_id'] ?? r['voucher_id'] ?? r['id']);
        const g = groups.get(key) ?? {
          date: String(r['date']),
          source: sources.get(String(r['id'])) ?? { kind: 'other' },
          narration: (r['narration'] as string | null) ?? null,
          lines: [],
          totalPaise: 0n,
        };
        g.lines.push({
          code: String(r['code']),
          name: String(r['name']),
          debitPaise: big(r['debit_paise']),
          creditPaise: big(r['credit_paise']),
        });
        g.totalPaise += big(r['debit_paise']);
        groups.set(key, g);
      }
      return [...groups.values()];
    });
  }
}

/* ------------------------------------------------------------------------------- year end */

export class FiscalYearRepo extends BaseRepo {
  private readonly journal: JournalRepo;
  private readonly chart: ChartRepo;
  private readonly lock: PeriodLockRepo;

  constructor(d: Database) {
    super(d, 'fiscal_years');
    this.journal = new JournalRepo(d);
    this.chart = new ChartRepo(d);
    this.lock = new PeriodLockRepo(d);
  }

  /** The years the books span, oldest first, with their state. */
  async years(ctx: Ctx): Promise<FiscalYearView[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const startMonth = Number(
        (await new BusinessRepo(this.d).get({ ...ctx, tx }))?.['fy_start_month'] ?? 4,
      );
      const le = this.d.schema.ledger_entries;
      const [range]: Row[] = await tx
        .select({ min: sql<string>`min(${le.date})`, max: sql<string>`max(${le.date})` })
        .from(le)
        .where(and(eq(le.business_id, ctx.businessId), isNull(le.deleted_at)));
      const t = this.t;
      const rows: Row[] = await tx
        .select()
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
      const byStart = new Map(rows.map((r) => [String(r['fy_start']), r]));
      const starts = new Set<string>(byStart.keys());
      if (range?.['min'] && range?.['max']) {
        let fy = fyOf(String(range['min']), startMonth);
        const last = fyOf(String(range['max']), startMonth);
        for (let i = 0; i < 60 && fy.startYear <= last.startYear; i++) {
          starts.add(fy.start);
          fy = financialYear(fy.startYear + 1, startMonth);
        }
      }
      const out: FiscalYearView[] = [];
      for (const start of [...starts].sort()) {
        const fy = fyOf(start, startMonth);
        const r = byStart.get(start);
        const [n]: Row[] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(le)
          .where(
            and(
              eq(le.business_id, ctx.businessId),
              isNull(le.deleted_at),
              gte(le.date, fy.start),
              lte(le.date, fy.end),
            ),
          );
        out.push({
          fyStart: fy.start,
          fyEnd: fy.end,
          label: fy.label,
          status: r?.['status'] === 'closed' ? 'closed' : 'open',
          closedAt: r?.['closed_at'] == null ? null : Number(r['closed_at']),
          closedBy: (r?.['closed_by'] as string | null) ?? null,
          closingVoucherId: (r?.['closing_voucher_id'] as string | null) ?? null,
          reopenedAt: r?.['reopened_at'] == null ? null : Number(r['reopened_at']),
          reopenReason: (r?.['reopen_reason'] as string | null) ?? null,
          entries: Number(n?.['n'] ?? 0),
        });
      }
      return out;
    });
  }

  /**
   * Close a year: every income and expense account is brought to zero into Retained Earnings by one
   * `closing` voucher dated the last day, and the books are locked up to that day. Earlier years must be
   * closed first.
   */
  async close(ctx: Ctx, fyStart: string): Promise<FiscalYearView> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const years = await this.years(c);
      const year = years.find((y) => y.fyStart === fyStart);
      if (!year) throw new RuleError('That year has no entries.');
      if (year.status === 'closed') throw new RuleError(`${year.label} is already closed.`);
      const earlierOpen = years.find(
        (y) => y.fyStart < fyStart && y.status === 'open' && y.entries > 0,
      );
      if (earlierOpen) throw new RuleError(`Close ${earlierOpen.label} first.`);
      await this.chart.ensureSystem(c);
      const accounts = await this.chart.accountsIn(tx, ctx);
      const retained = accounts.find((a) => a.code === ACCOUNTS.retainedEarnings[0]);
      if (!retained) throw new RuleError('The Retained Earnings account is missing.');
      const excludeVoucherIds = await closingVoucherIdsIn(this.d, tx, ctx);
      const sums = await sumsIn(
        this.d,
        tx,
        ctx,
        { from: year.fyStart, to: year.fyEnd },
        { excludeVoucherIds },
      );
      const lines = closingEntries(accounts, sums, retained.id);
      let voucherId: string | null = null;
      if (lines.length) {
        const v = await this.journal.post(c, {
          date: year.fyEnd,
          kind: 'closing',
          narration: `Year-end close ${year.label}`,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debitPaise: l.debitPaise,
            creditPaise: l.creditPaise,
          })),
        });
        voucherId = v.id;
      }
      const now = Date.now();
      const t = this.t;
      const [existing]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(eq(t.business_id, ctx.businessId), eq(t.fy_start, fyStart), isNull(t.deleted_at)),
        )
        .limit(1);
      const values: NewRow = {
        status: 'closed',
        closing_voucher_id: voucherId,
        closed_at: now,
        closed_by: ctx.actor,
      };
      const rowId = existing
        ? String(
            (
              await this.updateIn(
                tx,
                ctx,
                String(existing['id']),
                values,
                Number(existing['version']),
              )
            )['id'],
          )
        : String(
            (
              await this.createIn(tx, ctx, {
                fy_start: year.fyStart,
                fy_end: year.fyEnd,
                ...values,
              })
            )['id'],
          );
      const lock = await this.lock.get(c);
      if (!lock || lock.until < year.fyEnd)
        await this.lock.set(c, year.fyEnd, `Year-end close ${year.label}`);
      await writeAudit(
        this.d,
        tx,
        c,
        'fiscal_year',
        rowId,
        'update',
        { status: 'open', fy: year.label },
        { status: 'closed', voucherId },
      );
      return (await this.years(c)).find((y) => y.fyStart === fyStart)!;
    });
  }

  /** Reopen a closed year: an owner, with a reason; the closing voucher is reversed and the lock moved back. */
  async reopen(ctx: Ctx, fyStart: string, reason: string): Promise<FiscalYearView> {
    if ((ctx.role ?? 'owner') !== 'owner')
      throw new RuleError('Only an owner can reopen a closed year.');
    if (!reason.trim()) throw new RuleError('Say why the year is being reopened.');
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const years = await this.years(c);
      const year = years.find((y) => y.fyStart === fyStart);
      if (!year || year.status !== 'closed') throw new RuleError('That year is not closed.');
      const laterClosed = years.find((y) => y.fyStart > fyStart && y.status === 'closed');
      if (laterClosed) throw new RuleError(`Reopen ${laterClosed.label} first.`);
      const override: LockOverride = { reason: reason.trim() };
      if (year.closingVoucherId)
        await this.journal.reverse(
          c,
          year.closingVoucherId,
          `Year reopened: ${reason.trim()}`,
          year.fyEnd,
          override,
        );
      const t = this.t;
      const [existing]: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(eq(t.business_id, ctx.businessId), eq(t.fy_start, fyStart), isNull(t.deleted_at)),
        )
        .limit(1);
      await this.updateIn(
        tx,
        ctx,
        String(existing!['id']),
        {
          status: 'open',
          reopened_at: Date.now(),
          reopened_by: ctx.actor,
          reopen_reason: reason.trim(),
        },
        Number(existing!['version']),
      );
      const lock = await this.lock.get(c);
      if (lock && lock.until >= year.fyStart) {
        const before = dayBefore(year.fyStart);
        const earlierClosed = years
          .filter((y) => y.fyStart < fyStart && y.status === 'closed')
          .at(-1);
        await this.lock.set(c, earlierClosed ? earlierClosed.fyEnd : null, reason.trim());
        void before;
      }
      await writeAudit(
        this.d,
        tx,
        c,
        'fiscal_year',
        String(existing!['id']),
        'update',
        { status: 'closed', fy: year.label },
        { status: 'open', reason: reason.trim() },
      );
      return (await this.years(c)).find((y) => y.fyStart === fyStart)!;
    });
  }
}

/* ---------------------------------------------------------------------------- verify, repair */

export class LedgerAudit {
  private readonly chart: ChartRepo;
  private readonly flow: DocumentFlowRepo;

  constructor(private readonly d: Database) {
    this.chart = new ChartRepo(d);
    this.flow = new DocumentFlowRepo(d);
  }

  /** What is missing or does not tie, without changing anything. */
  async verify(ctx: Ctx, today: string): Promise<LedgerVerification> {
    return runInTx(this.d, ctx, async (tx) => {
      const le = this.d.schema.ledger_entries;
      const docs = this.d.schema.documents;
      const pays = this.d.schema.payments;
      const posted: Row[] = await tx
        .select({
          document_id: le.document_id,
          payment_id: le.payment_id,
          voucher_id: le.voucher_id,
          dr: sql<number>`sum(${le.debit_paise})`,
          cr: sql<number>`sum(${le.credit_paise})`,
        })
        .from(le)
        .where(and(eq(le.business_id, ctx.businessId), isNull(le.deleted_at)))
        .groupBy(le.document_id, le.payment_id, le.voucher_id);
      const byDoc = new Map<string, { dr: number; cr: number }>();
      const byPay = new Set<string>();
      const byVoucher = new Map<string, { dr: number; cr: number }>();
      for (const p of posted) {
        if (p['document_id'])
          byDoc.set(String(p['document_id']), { dr: Number(p['dr']), cr: Number(p['cr']) });
        if (p['payment_id']) byPay.add(String(p['payment_id']));
        if (p['voucher_id'])
          byVoucher.set(String(p['voucher_id']), { dr: Number(p['dr']), cr: Number(p['cr']) });
      }
      const issued: Row[] = await tx
        .select({ id: docs.id, type: docs.type })
        .from(docs)
        .where(
          and(
            eq(docs.business_id, ctx.businessId),
            eq(docs.status, 'issued'),
            isNull(docs.deleted_at),
          ),
        );
      const postingDocs = issued.filter((d) => POSTS_TO_LEDGER.has(d['type'] as DocumentType));
      const missingDocs = postingDocs
        .filter((d) => !byDoc.has(String(d['id'])))
        .map((d) => String(d['id']));
      const unbalanced = [...byDoc.entries()].filter(([, s]) => s.dr !== s.cr).map(([id]) => id);
      const cleared: Row[] = await tx
        .select({ id: pays.id })
        .from(pays)
        .where(
          and(
            eq(pays.business_id, ctx.businessId),
            eq(pays.status, 'cleared'),
            isNull(pays.deleted_at),
          ),
        );
      const missingPays = cleared
        .filter((p) => !byPay.has(String(p['id'])))
        .map((p) => String(p['id']));
      const v = this.d.schema.journal_vouchers;
      const vouchers: Row[] = await tx
        .select({ id: v.id })
        .from(v)
        .where(and(eq(v.business_id, ctx.businessId), isNull(v.deleted_at)));
      const unbalancedVouchers = vouchers
        .filter((x) => {
          const s = byVoucher.get(String(x['id']));
          return !s || s.dr !== s.cr;
        })
        .map((x) => String(x['id']));

      // the parties' positions are as of now (every document and payment there is), so the control accounts
      // are read the same way: everything posted, whatever its date
      const accounts = await this.chart.accountsIn(tx, ctx);
      const sums = new Map((await sumsIn(this.d, tx, ctx, {})).map((s) => [s.accountId, s]));
      const bal = (code: string) => {
        const a = accounts.find((x) => x.code === code);
        const s = a ? sums.get(a.id) : undefined;
        return s ? s.debitPaise - s.creditPaise : 0n;
      };
      const receivables = bal(ACCOUNTS.receivables[0]);
      const payables = -bal(ACCOUNTS.payables[0]);
      // the parties' side: each party's position (opening, open documents, unused credit), signed as
      // they owe us; summed it is what the two control accounts should hold between them
      const flow = new PaymentFlowRepo(this.d);
      const pr = this.d.schema.parties;
      const partyRows: Row[] = await tx
        .select({ id: pr.id })
        .from(pr)
        .where(and(eq(pr.business_id, ctx.businessId), isNull(pr.deleted_at)));
      let partiesNet = 0n;
      for (const p of partyRows)
        partiesNet += (await flow.partyPosition({ ...ctx, tx }, String(p['id']), today))
          .outstandingPaise;
      const ledgerNet = receivables - payables;
      return {
        documents: { checked: postingDocs.length, missing: missingDocs, unbalanced },
        payments: { checked: cleared.length, missing: missingPays },
        control: {
          ledgerNetPaise: ledgerNet,
          partiesNetPaise: partiesNet,
          differencePaise: ledgerNet - partiesNet,
          receivablesLedgerPaise: receivables,
          payablesLedgerPaise: payables,
        },
        legacyTax: {
          outputPaise: -bal(LEGACY_TAX_ACCOUNTS.output),
          inputPaise: bal(LEGACY_TAX_ACCOUNTS.input),
        },
        vouchers: { checked: vouchers.length, unbalanced: unbalancedVouchers },
      };
    });
  }

  /** Post what the rules say for every issued document and cleared payment that has no entries. */
  async repair(ctx: Ctx, today: string): Promise<{ documents: number; payments: number }> {
    const before = await this.verify(ctx, today);
    let documents = 0;
    let payments = 0;
    await runInTx(this.d, ctx, async (tx) => {
      const entries = new BaseRepo(this.d, 'ledger_entries');
      const docs = this.d.schema.documents;
      for (const id of before.documents.missing) {
        const [doc]: Row[] = await tx.select().from(docs).where(eq(docs.id, id)).limit(1);
        if (!doc) continue;
        const n = (k: string) => big(doc[k]);
        const lines = postDocument({
          type: doc['type'] as DocumentType,
          status: 'issued',
          taxablePaise: n('total_taxable_paise'),
          cgstPaise: n('total_cgst_paise'),
          sgstPaise: n('total_sgst_paise'),
          utgstPaise: n('total_utgst_paise'),
          igstPaise: n('total_igst_paise'),
          cessPaise: n('total_cess_paise'),
          tcsPaise: n('tcs_paise'),
          roundOffPaise: n('round_off_paise'),
          totalPaise: n('total_paise'),
          reverseCharge: !!doc['reverse_charge'],
        });
        for (const l of lines)
          await (entries as any).createIn(tx, ctx, {
            document_id: id,
            party_id:
              l.account === 'receivables' || l.account === 'payables' ? doc['party_id'] : null,
            account_id: await this.flow.accountIdIn(tx, ctx, l.account),
            debit_paise: num(l.debitPaise),
            credit_paise: num(l.creditPaise),
            date: doc['date'],
            narration: `${l.narration} (repaired)`,
          });
        documents++;
      }
      const pays = this.d.schema.payments;
      for (const id of before.payments.missing) {
        const [p]: Row[] = await tx.select().from(pays).where(eq(pays.id, id)).limit(1);
        if (!p) continue;
        const lines = postPayment({
          direction: p['direction'] as 'received' | 'made',
          mode: p['mode'] as never,
          amountPaise: big(p['amount_paise']),
          ...(big(p['tcs_paise']) > 0n ? { tcsPaise: big(p['tcs_paise']) } : {}),
        });
        for (const l of lines)
          await (entries as any).createIn(tx, ctx, {
            payment_id: id,
            party_id:
              l.account === 'receivables' || l.account === 'payables' ? p['party_id'] : null,
            account_id:
              l.account === 'bank' && p['account_id']
                ? await this.chart.bankLedgerIdIn(tx, ctx, String(p['account_id']))
                : await this.flow.accountIdIn(tx, ctx, l.account),
            debit_paise: num(l.debitPaise),
            credit_paise: num(l.creditPaise),
            date: p['date'],
            narration: `${l.narration} (repaired)`,
          });
        payments++;
      }
    });
    return { documents, payments };
  }

  /**
   * Move what the old aggregate tax ledgers hold onto the per-head ledgers, year by year, with a `reclass`
   * voucher built from the documents themselves (so each head gets exactly what its invoices carried).
   */
  async reclassifyTaxHeads(ctx: Ctx, fyStart: string, fyEnd: string): Promise<Voucher | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      await this.chart.ensureSystem(c);
      const accounts = await this.chart.accountsIn(tx, ctx);
      const byCode = new Map(accounts.map((a) => [a.code, a.id]));
      const legacyOut = byCode.get(LEGACY_TAX_ACCOUNTS.output);
      const legacyIn = byCode.get(LEGACY_TAX_ACCOUNTS.input);
      if (!legacyOut && !legacyIn) return null;
      const le = this.d.schema.ledger_entries;
      const docs = this.d.schema.documents;
      // entries on the legacy ledgers in the year, by document: re-run the rules to find each head's share
      const rows: Row[] = await tx
        .select({ document_id: le.document_id })
        .from(le)
        .where(
          and(
            eq(le.business_id, ctx.businessId),
            isNull(le.deleted_at),
            inArray(
              le.account_id,
              [legacyOut, legacyIn].filter((x): x is string => !!x),
            ),
            gte(le.date, fyStart),
            lte(le.date, fyEnd),
          ),
        )
        .groupBy(le.document_id);
      const perAccount = new Map<string, bigint>(); // debit-positive net to move onto each per-head ledger
      for (const r of rows) {
        if (!r['document_id']) continue;
        const [doc]: Row[] = await tx
          .select()
          .from(docs)
          .where(eq(docs.id, String(r['document_id'])))
          .limit(1);
        if (!doc) continue;
        const n = (k: string) => big(doc[k]);
        const lines = postDocument({
          type: doc['type'] as DocumentType,
          status: 'issued',
          taxablePaise: n('total_taxable_paise'),
          cgstPaise: n('total_cgst_paise'),
          sgstPaise: n('total_sgst_paise'),
          utgstPaise: n('total_utgst_paise'),
          igstPaise: n('total_igst_paise'),
          cessPaise: n('total_cess_paise'),
          tcsPaise: n('tcs_paise'),
          roundOffPaise: n('round_off_paise'),
          totalPaise: n('total_paise'),
          reverseCharge: !!doc['reverse_charge'],
        });
        for (const l of lines) {
          if (!/^(output|input)/.test(l.account)) continue;
          perAccount.set(
            l.account,
            (perAccount.get(l.account) ?? 0n) + l.debitPaise - l.creditPaise,
          );
        }
      }
      const voucherLines: VoucherLineInput[] = [];
      let outNet = 0n;
      let inNet = 0n;
      for (const [key, net] of perAccount) {
        if (net === 0n) continue;
        const id = await this.flow.accountIdIn(tx, ctx, key as AccountKey);
        voucherLines.push({
          accountId: id,
          debitPaise: net > 0n ? net : 0n,
          creditPaise: net < 0n ? -net : 0n,
        });
        if (key.startsWith('output')) outNet += net;
        else inNet += net;
      }
      if (legacyOut && outNet !== 0n)
        voucherLines.push({
          accountId: legacyOut,
          debitPaise: outNet < 0n ? -outNet : 0n,
          creditPaise: outNet > 0n ? outNet : 0n,
        });
      if (legacyIn && inNet !== 0n)
        voucherLines.push({
          accountId: legacyIn,
          debitPaise: inNet < 0n ? -inNet : 0n,
          creditPaise: inNet > 0n ? inNet : 0n,
        });
      if (!voucherLines.length) return null;
      return new JournalRepo(this.d).post(c, {
        date: fyEnd,
        kind: 'reclass',
        narration: 'Tax ledgers split by head',
        lines: voucherLines,
      });
    });
  }
}
