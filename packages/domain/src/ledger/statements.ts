/**
 * The financial statements (prompt 50), as pure arithmetic over account balances: the trial balance, the
 * ledger statement's running balance, profit and loss, the balance sheet and a simple indirect cash flow, plus
 * the closing entries of a financial year. The database hands in the accounts and their debit and credit sums;
 * nothing here reads or writes. Every statement is checked to tie: a trial balance whose two columns differ
 * throws, and the balance sheet carries the difference it found (zero when the books are right).
 */
import { sum } from '../money';

export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

export interface AccountMeta {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subGroup: string | null;
  parentId?: string | null;
}

/** Debit and credit sums of an account over a span. */
export interface AccountSums {
  accountId: string;
  debitPaise: bigint;
  creditPaise: bigint;
}

export class StatementError extends Error {
  override name = 'StatementError';
}

/** Debit balances are positive for assets and expenses; credit balances are positive for the rest. */
export const naturalSide = (type: AccountType): 'dr' | 'cr' =>
  type === 'asset' || type === 'expense' ? 'dr' : 'cr';

/** The account's balance on its natural side: positive is normal, negative is the other way round. */
export function naturalBalance(type: AccountType, debitPaise: bigint, creditPaise: bigint): bigint {
  return naturalSide(type) === 'dr' ? debitPaise - creditPaise : creditPaise - debitPaise;
}

const index = (sums: readonly AccountSums[]) => new Map(sums.map((s) => [s.accountId, s]));
const zero = { debitPaise: 0n, creditPaise: 0n };

/* ------------------------------------------------------------------------------- trial balance */

export interface TrialBalanceRow {
  account: AccountMeta;
  openingDrPaise: bigint;
  openingCrPaise: bigint;
  debitPaise: bigint;
  creditPaise: bigint;
  closingDrPaise: bigint;
  closingCrPaise: bigint;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'account'>;
}

/** A debit-minus-credit figure as a (dr, cr) pair with one side zero. */
const split = (net: bigint): [bigint, bigint] => (net >= 0n ? [net, 0n] : [0n, -net]);

/**
 * The trial balance: what each account carried into the span, its movement, and what it carries out.
 * Accounts with nothing in any column are left out. Throws when the closing columns differ.
 */
export function trialBalance(
  accounts: readonly AccountMeta[],
  opening: readonly AccountSums[],
  period: readonly AccountSums[],
): TrialBalance {
  const o = index(opening);
  const p = index(period);
  const rows: TrialBalanceRow[] = [];
  for (const account of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    const op = o.get(account.id) ?? zero;
    const pe = p.get(account.id) ?? zero;
    const [openingDrPaise, openingCrPaise] = split(op.debitPaise - op.creditPaise);
    const [closingDrPaise, closingCrPaise] = split(
      op.debitPaise - op.creditPaise + pe.debitPaise - pe.creditPaise,
    );
    if (
      openingDrPaise === 0n &&
      openingCrPaise === 0n &&
      pe.debitPaise === 0n &&
      pe.creditPaise === 0n
    )
      continue;
    rows.push({
      account,
      openingDrPaise,
      openingCrPaise,
      debitPaise: pe.debitPaise,
      creditPaise: pe.creditPaise,
      closingDrPaise,
      closingCrPaise,
    });
  }
  const totals = {
    openingDrPaise: sum(rows.map((r) => r.openingDrPaise)),
    openingCrPaise: sum(rows.map((r) => r.openingCrPaise)),
    debitPaise: sum(rows.map((r) => r.debitPaise)),
    creditPaise: sum(rows.map((r) => r.creditPaise)),
    closingDrPaise: sum(rows.map((r) => r.closingDrPaise)),
    closingCrPaise: sum(rows.map((r) => r.closingCrPaise)),
  };
  if (totals.closingDrPaise !== totals.closingCrPaise)
    throw new StatementError(
      `the trial balance does not balance: debit ${totals.closingDrPaise} != credit ${totals.closingCrPaise}`,
    );
  return { rows, totals };
}

/* ---------------------------------------------------------------------------- ledger statement */

export interface StatementEntry {
  date: string;
  debitPaise: bigint;
  creditPaise: bigint;
}

/** Running balances on the account's natural side, from an opening balance. */
export function runningBalances<T extends StatementEntry>(
  type: AccountType,
  openingPaise: bigint,
  entries: readonly T[],
): (T & { balancePaise: bigint })[] {
  let bal = openingPaise;
  const dr = naturalSide(type) === 'dr';
  return entries.map((e) => {
    bal += dr ? e.debitPaise - e.creditPaise : e.creditPaise - e.debitPaise;
    return { ...e, balancePaise: bal };
  });
}

/* --------------------------------------------------------------------------- profit and loss */

export interface AccountLine {
  account: AccountMeta;
  /** On the account's natural side. */
  paise: bigint;
  /** The same for the comparative span, when asked for. */
  comparePaise: bigint | null;
}

export interface StatementGroup {
  subGroup: string;
  lines: AccountLine[];
  paise: bigint;
  comparePaise: bigint | null;
}

export interface ProfitAndLoss {
  income: StatementGroup[];
  expenses: StatementGroup[];
  incomePaise: bigint;
  expensesPaise: bigint;
  /** Income less expenses; negative is a loss. */
  netPaise: bigint;
  compare: { incomePaise: bigint; expensesPaise: bigint; netPaise: bigint } | null;
}

function groups(
  accounts: readonly AccountMeta[],
  type: AccountType,
  sums: Map<string, AccountSums>,
  compare: Map<string, AccountSums> | null,
  fallback: string,
): StatementGroup[] {
  const by = new Map<string, StatementGroup>();
  for (const a of [...accounts]
    .filter((x) => x.type === type)
    .sort((x, y) => x.code.localeCompare(y.code))) {
    const s = sums.get(a.id);
    const c = compare?.get(a.id);
    const paise = s ? naturalBalance(type, s.debitPaise, s.creditPaise) : 0n;
    const comparePaise = compare
      ? c
        ? naturalBalance(type, c.debitPaise, c.creditPaise)
        : 0n
      : null;
    if (paise === 0n && (comparePaise ?? 0n) === 0n) continue;
    const key = a.subGroup ?? fallback;
    const g = by.get(key) ?? {
      subGroup: key,
      lines: [],
      paise: 0n,
      comparePaise: compare ? 0n : null,
    };
    g.lines.push({ account: a, paise, comparePaise });
    g.paise += paise;
    if (compare) g.comparePaise = (g.comparePaise ?? 0n) + (comparePaise ?? 0n);
    by.set(key, g);
  }
  return [...by.values()];
}

const total = (gs: readonly StatementGroup[]) => sum(gs.map((g) => g.paise));
const totalCompare = (gs: readonly StatementGroup[]) => sum(gs.map((g) => g.comparePaise ?? 0n));

/** Income and expenses over a span (the sums are the span's movements), with an optional comparative span. */
export function profitAndLoss(
  accounts: readonly AccountMeta[],
  period: readonly AccountSums[],
  compare: readonly AccountSums[] | null = null,
): ProfitAndLoss {
  const p = index(period);
  const c = compare ? index(compare) : null;
  const income = groups(accounts, 'income', p, c, 'other_income');
  const expenses = groups(accounts, 'expense', p, c, 'indirect_expenses');
  const incomePaise = total(income);
  const expensesPaise = total(expenses);
  return {
    income,
    expenses,
    incomePaise,
    expensesPaise,
    netPaise: incomePaise - expensesPaise,
    compare: compare
      ? {
          incomePaise: totalCompare(income),
          expensesPaise: totalCompare(expenses),
          netPaise: totalCompare(income) - totalCompare(expenses),
        }
      : null,
  };
}

/* ------------------------------------------------------------------------------ balance sheet */

export interface BalanceSheet {
  assets: StatementGroup[];
  liabilities: StatementGroup[];
  equity: StatementGroup[];
  assetsPaise: bigint;
  liabilitiesPaise: bigint;
  equityPaise: bigint;
  /** Income less expenses of every year not yet closed, as at the date: the owner's share not yet booked. */
  unclosedProfitPaise: bigint;
  /** Assets less liabilities, equity and the unclosed profit: zero when the books tie. */
  differencePaise: bigint;
  compare: {
    assetsPaise: bigint;
    liabilitiesPaise: bigint;
    equityPaise: bigint;
    unclosedProfitPaise: bigint;
  } | null;
}

/** The position as at a date (the sums are everything up to it), with an optional earlier date. */
export function balanceSheet(
  accounts: readonly AccountMeta[],
  asAt: readonly AccountSums[],
  compare: readonly AccountSums[] | null = null,
): BalanceSheet {
  const p = index(asAt);
  const c = compare ? index(compare) : null;
  const assets = groups(accounts, 'asset', p, c, 'current_assets');
  const liabilities = groups(accounts, 'liability', p, c, 'current_liabilities');
  const equity = groups(accounts, 'equity', p, c, 'capital');
  const profit = (m: Map<string, AccountSums>) =>
    sum(
      accounts
        .filter((a) => a.type === 'income' || a.type === 'expense')
        .map((a) => {
          const s = m.get(a.id);
          if (!s) return 0n;
          const n = naturalBalance(a.type, s.debitPaise, s.creditPaise);
          return a.type === 'income' ? n : -n;
        }),
    );
  const assetsPaise = total(assets);
  const liabilitiesPaise = total(liabilities);
  const equityPaise = total(equity);
  const unclosedProfitPaise = profit(p);
  return {
    assets,
    liabilities,
    equity,
    assetsPaise,
    liabilitiesPaise,
    equityPaise,
    unclosedProfitPaise,
    differencePaise: assetsPaise - liabilitiesPaise - equityPaise - unclosedProfitPaise,
    compare: c
      ? {
          assetsPaise: totalCompare(assets),
          liabilitiesPaise: totalCompare(liabilities),
          equityPaise: totalCompare(equity),
          unclosedProfitPaise: profit(c),
        }
      : null,
  };
}

/* ---------------------------------------------------------------------------------- cash flow */

export interface CashFlowLine {
  label: string;
  paise: bigint;
}

export interface CashFlow {
  netProfitPaise: bigint;
  /** Changes in the non-cash working capital accounts: receivables up is money out. */
  operating: CashFlowLine[];
  operatingPaise: bigint;
  /** Capital in, drawings out, loans. */
  financing: CashFlowLine[];
  financingPaise: bigint;
  /** Other asset movements (fixed assets, investments). */
  investing: CashFlowLine[];
  investingPaise: bigint;
  openingCashPaise: bigint;
  closingCashPaise: bigint;
  /** Opening plus the three sections, which must equal the closing cash and bank. */
  netChangePaise: bigint;
  /** Closing less (opening plus net change): zero when the ledger ties. */
  differencePaise: bigint;
}

const CASH_GROUPS = new Set(['cash', 'bank']);
const FINANCING_GROUPS = new Set(['capital', 'drawings', 'loans', 'reserves']);
const INVESTING_GROUPS = new Set(['fixed_assets', 'investments']);

/**
 * The indirect cash flow over a span: the span's profit, then the change in each non-cash balance sheet
 * account (an asset rising uses cash, a liability or equity rising brings it), and the cash accounts' own
 * change to tie against.
 */
export function cashFlow(
  accounts: readonly AccountMeta[],
  period: readonly AccountSums[],
  openingAsAt: readonly AccountSums[],
): CashFlow {
  const p = index(period);
  const o = index(openingAsAt);
  const movement = (a: AccountMeta) => {
    const s = p.get(a.id);
    return s ? s.debitPaise - s.creditPaise : 0n;
  };
  let netProfitPaise = 0n;
  const operating: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  let openingCashPaise = 0n;
  let closingCashPaise = 0n;
  for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code))) {
    const net = movement(a);
    if (a.type === 'income' || a.type === 'expense') {
      netProfitPaise -= net; // income is a credit (negative net): profit up
      continue;
    }
    const g = a.subGroup ?? '';
    if (a.type === 'asset' && CASH_GROUPS.has(g)) {
      const op = o.get(a.id);
      const opening = op ? op.debitPaise - op.creditPaise : 0n;
      openingCashPaise += opening;
      closingCashPaise += opening + net;
      continue;
    }
    if (net === 0n) continue;
    // a debit movement on a non-cash account is cash leaving; a credit movement is cash arriving
    const line = { label: a.name, paise: -net };
    if (FINANCING_GROUPS.has(g) || (a.type === 'equity' && !FINANCING_GROUPS.has(g)))
      financing.push(line);
    else if (INVESTING_GROUPS.has(g)) investing.push(line);
    else operating.push(line);
  }
  const operatingPaise = sum(operating.map((l) => l.paise));
  const financingPaise = sum(financing.map((l) => l.paise));
  const investingPaise = sum(investing.map((l) => l.paise));
  const netChangePaise = netProfitPaise + operatingPaise + financingPaise + investingPaise;
  return {
    netProfitPaise,
    operating,
    operatingPaise,
    financing,
    financingPaise,
    investing,
    investingPaise,
    openingCashPaise,
    closingCashPaise,
    netChangePaise,
    differencePaise: closingCashPaise - (openingCashPaise + netChangePaise),
  };
}

/* ------------------------------------------------------------------------------- year-end close */

export interface ClosingLine {
  accountId: string;
  debitPaise: bigint;
  creditPaise: bigint;
}

/**
 * The entries that close a year: every income and expense account is brought to zero and the net goes to
 * retained earnings. Returns nothing when there is nothing to close.
 */
export function closingEntries(
  accounts: readonly AccountMeta[],
  year: readonly AccountSums[],
  retainedEarningsId: string,
): ClosingLine[] {
  const p = index(year);
  const lines: ClosingLine[] = [];
  let net = 0n; // credit-positive
  for (const a of accounts) {
    if (a.type !== 'income' && a.type !== 'expense') continue;
    const s = p.get(a.id);
    if (!s) continue;
    const bal = s.debitPaise - s.creditPaise; // debit-positive
    if (bal === 0n) continue;
    // reverse the balance: a credit balance (income) is debited away, a debit balance credited away
    lines.push({
      accountId: a.id,
      debitPaise: bal < 0n ? -bal : 0n,
      creditPaise: bal > 0n ? bal : 0n,
    });
    net -= bal;
  }
  if (!lines.length) return [];
  lines.push({
    accountId: retainedEarningsId,
    debitPaise: net < 0n ? -net : 0n,
    creditPaise: net > 0n ? net : 0n,
  });
  const dr = sum(lines.map((l) => l.debitPaise));
  const cr = sum(lines.map((l) => l.creditPaise));
  if (dr !== cr) throw new StatementError(`closing entries do not balance: ${dr} != ${cr}`);
  return lines;
}

/** The groups the statements know, in the order they are shown. */
export const SUB_GROUPS: Record<AccountType, string[]> = {
  asset: [
    'cash',
    'bank',
    'receivables',
    'duties_taxes',
    'current_assets',
    'fixed_assets',
    'investments',
  ],
  liability: ['payables', 'duties_taxes', 'current_liabilities', 'loans'],
  equity: ['capital', 'reserves', 'drawings'],
  income: ['sales', 'other_income'],
  expense: ['purchases', 'direct_expenses', 'indirect_expenses'],
};
