/**
 * The financial statements as arithmetic (prompt 50): the trial balance ties, the running balance follows
 * the account's side, profit and loss and the balance sheet agree with each other, the year-end close brings
 * every income and expense account to zero, the cash flow ties to the cash accounts, and a property test:
 * any sequence of documents and payments the posting rules accept produces a trial balance that balances.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  balanceSheet,
  cashFlow,
  closingEntries,
  naturalBalance,
  postDocument,
  postPayment,
  profitAndLoss,
  runningBalances,
  trialBalance,
  type AccountKey,
  type AccountMeta,
  type AccountSums,
  type LedgerLine,
  type PostableDocument,
} from '../src';

const META: Record<string, AccountMeta> = {
  cash: { id: 'cash', code: '1000', name: 'Cash', type: 'asset', subGroup: 'cash' },
  bank: { id: 'bank', code: '1100', name: 'Bank', type: 'asset', subGroup: 'bank' },
  receivables: {
    id: 'receivables',
    code: '1200',
    name: 'Receivables',
    type: 'asset',
    subGroup: 'receivables',
  },
  inputCgst: {
    id: 'inputCgst',
    code: '1310',
    name: 'Input CGST',
    type: 'asset',
    subGroup: 'duties_taxes',
  },
  inputSgst: {
    id: 'inputSgst',
    code: '1320',
    name: 'Input SGST',
    type: 'asset',
    subGroup: 'duties_taxes',
  },
  inputUtgst: {
    id: 'inputUtgst',
    code: '1330',
    name: 'Input UTGST',
    type: 'asset',
    subGroup: 'duties_taxes',
  },
  inputIgst: {
    id: 'inputIgst',
    code: '1340',
    name: 'Input IGST',
    type: 'asset',
    subGroup: 'duties_taxes',
  },
  inputCess: {
    id: 'inputCess',
    code: '1350',
    name: 'Input Cess',
    type: 'asset',
    subGroup: 'duties_taxes',
  },
  payables: {
    id: 'payables',
    code: '2000',
    name: 'Payables',
    type: 'liability',
    subGroup: 'payables',
  },
  outputCgst: {
    id: 'outputCgst',
    code: '2110',
    name: 'Output CGST',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  outputSgst: {
    id: 'outputSgst',
    code: '2120',
    name: 'Output SGST',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  outputUtgst: {
    id: 'outputUtgst',
    code: '2130',
    name: 'Output UTGST',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  outputIgst: {
    id: 'outputIgst',
    code: '2140',
    name: 'Output IGST',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  outputCess: {
    id: 'outputCess',
    code: '2150',
    name: 'Output Cess',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  tcsPayable: {
    id: 'tcsPayable',
    code: '2200',
    name: 'TCS Payable',
    type: 'liability',
    subGroup: 'duties_taxes',
  },
  capital: { id: 'capital', code: '3000', name: 'Capital', type: 'equity', subGroup: 'capital' },
  openingEquity: {
    id: 'openingEquity',
    code: '3100',
    name: 'Opening Balance Equity',
    type: 'equity',
    subGroup: 'capital',
  },
  retainedEarnings: {
    id: 'retainedEarnings',
    code: '3200',
    name: 'Retained Earnings',
    type: 'equity',
    subGroup: 'reserves',
  },
  sales: { id: 'sales', code: '4000', name: 'Sales', type: 'income', subGroup: 'sales' },
  purchases: {
    id: 'purchases',
    code: '5000',
    name: 'Purchases',
    type: 'expense',
    subGroup: 'purchases',
  },
  expenses: {
    id: 'expenses',
    code: '5100',
    name: 'Expenses',
    type: 'expense',
    subGroup: 'indirect_expenses',
  },
  roundOff: {
    id: 'roundOff',
    code: '5200',
    name: 'Round-off',
    type: 'expense',
    subGroup: 'indirect_expenses',
  },
  adjustments: {
    id: 'adjustments',
    code: '5300',
    name: 'Adjustments',
    type: 'expense',
    subGroup: 'indirect_expenses',
  },
  gatewayFees: {
    id: 'gatewayFees',
    code: '5400',
    name: 'Gateway fees',
    type: 'expense',
    subGroup: 'indirect_expenses',
  },
};
const accounts = Object.values(META);

/** Ledger lines summed per account, as the database would hand them back. */
function sumsOf(lines: readonly LedgerLine[]): AccountSums[] {
  const by = new Map<string, AccountSums>();
  for (const l of lines) {
    const s = by.get(l.account) ?? { accountId: l.account, debitPaise: 0n, creditPaise: 0n };
    s.debitPaise += l.debitPaise;
    s.creditPaise += l.creditPaise;
    by.set(l.account, s);
  }
  return [...by.values()];
}
const line = (account: AccountKey, dr: bigint, cr: bigint): LedgerLine => ({
  account,
  debitPaise: dr,
  creditPaise: cr,
  narration: '',
});

describe('trial balance', () => {
  it('ties, carries openings into closings, and throws when the entries do not balance', () => {
    const opening = sumsOf([line('cash', 10_000n, 0n), line('capital', 0n, 10_000n)]);
    const period = sumsOf([
      line('receivables', 11_800n, 0n),
      line('sales', 0n, 10_000n),
      line('outputCgst', 0n, 900n),
      line('outputSgst', 0n, 900n),
      line('cash', 5_000n, 0n),
      line('receivables', 0n, 5_000n),
    ]);
    const tb = trialBalance(accounts, opening, period);
    expect(tb.totals.closingDrPaise).toBe(tb.totals.closingCrPaise);
    expect(tb.totals.debitPaise).toBe(tb.totals.creditPaise);
    const cash = tb.rows.find((r) => r.account.id === 'cash')!;
    expect(cash).toMatchObject({
      openingDrPaise: 10_000n,
      debitPaise: 5_000n,
      closingDrPaise: 15_000n,
    });
    const recv = tb.rows.find((r) => r.account.id === 'receivables')!;
    expect(recv.closingDrPaise).toBe(6_800n);
    expect(tb.rows.map((r) => r.account.code)).toEqual(
      [...tb.rows.map((r) => r.account.code)].sort(),
    );
    expect(() =>
      trialBalance(accounts, [], [{ accountId: 'cash', debitPaise: 5n, creditPaise: 0n }]),
    ).toThrow(/does not balance/);
  });

  it('a running balance follows the account’s natural side', () => {
    const rows = runningBalances('asset', 100n, [
      { date: '2026-04-01', debitPaise: 50n, creditPaise: 0n },
      { date: '2026-04-02', debitPaise: 0n, creditPaise: 30n },
    ]);
    expect(rows.map((r) => r.balancePaise)).toEqual([150n, 120n]);
    const liab = runningBalances('liability', 100n, [
      { date: '2026-04-01', debitPaise: 40n, creditPaise: 0n },
    ]);
    expect(liab[0]!.balancePaise).toBe(60n);
    expect(naturalBalance('income', 10n, 100n)).toBe(90n);
    expect(naturalBalance('expense', 100n, 10n)).toBe(90n);
  });
});

describe('profit and loss, balance sheet, cash flow and the close', () => {
  const year = sumsOf([
    line('receivables', 118_000n, 0n),
    line('sales', 0n, 100_000n),
    line('outputCgst', 0n, 9_000n),
    line('outputSgst', 0n, 9_000n),
    line('purchases', 40_000n, 0n),
    line('inputCgst', 3_600n, 0n),
    line('inputSgst', 3_600n, 0n),
    line('payables', 0n, 47_200n),
    line('bank', 70_000n, 0n),
    line('receivables', 0n, 70_000n),
    line('payables', 20_000n, 0n),
    line('bank', 0n, 20_000n),
    line('expenses', 5_000n, 0n),
    line('cash', 0n, 5_000n),
  ]);
  const opening = sumsOf([line('cash', 30_000n, 0n), line('capital', 0n, 30_000n)]);

  it('P&L revenue is the sales account net, expenses group by sub-group, and a comparative is carried', () => {
    const pl = profitAndLoss(accounts, year, opening);
    expect(pl.incomePaise).toBe(100_000n);
    expect(pl.expensesPaise).toBe(45_000n);
    expect(pl.netPaise).toBe(55_000n);
    expect(pl.expenses.map((g) => g.subGroup)).toEqual(['purchases', 'indirect_expenses']);
    expect(pl.compare).toEqual({ incomePaise: 0n, expensesPaise: 0n, netPaise: 0n });
  });

  it('the balance sheet ties: assets = liabilities + equity + the profit not yet closed', () => {
    const asAt = sumsOf([
      ...opening.flatMap((s) => [line(s.accountId as AccountKey, s.debitPaise, s.creditPaise)]),
      ...year.flatMap((s) => [line(s.accountId as AccountKey, s.debitPaise, s.creditPaise)]),
    ]);
    const bs = balanceSheet(accounts, asAt);
    expect(bs.differencePaise).toBe(0n);
    expect(bs.unclosedProfitPaise).toBe(55_000n);
    expect(bs.assets.find((g) => g.subGroup === 'receivables')!.paise).toBe(48_000n);
    expect(bs.liabilities.find((g) => g.subGroup === 'payables')!.paise).toBe(27_200n);
    expect(bs.assetsPaise).toBe(bs.liabilitiesPaise + bs.equityPaise + bs.unclosedProfitPaise);
  });

  it('closing entries zero every income and expense account into retained earnings, and balance', () => {
    const lines = closingEntries(accounts, year, 'retainedEarnings');
    const dr = lines.reduce((a, l) => a + l.debitPaise, 0n);
    const cr = lines.reduce((a, l) => a + l.creditPaise, 0n);
    expect(dr).toBe(cr);
    expect(lines.find((l) => l.accountId === 'sales')).toMatchObject({ debitPaise: 100_000n });
    expect(lines.find((l) => l.accountId === 'retainedEarnings')).toMatchObject({
      creditPaise: 55_000n,
    });
    // after the close, the year's P&L accounts net to zero and the profit sits in equity
    const after = sumsOf([
      ...year.map((s) => line(s.accountId as AccountKey, s.debitPaise, s.creditPaise)),
      ...lines.map((l) => line(l.accountId as AccountKey, l.debitPaise, l.creditPaise)),
    ]);
    expect(profitAndLoss(accounts, after).netPaise).toBe(0n);
    expect(
      balanceSheet(accounts, [...opening, ...after]).equity.find((g) => g.subGroup === 'reserves')!
        .paise,
    ).toBe(55_000n);
    expect(closingEntries(accounts, [], 'retainedEarnings')).toEqual([]);
  });

  it('the indirect cash flow ties to the change in cash and bank', () => {
    const cf = cashFlow(accounts, year, opening);
    expect(cf.netProfitPaise).toBe(55_000n);
    expect(cf.openingCashPaise).toBe(30_000n);
    expect(cf.closingCashPaise).toBe(75_000n);
    expect(cf.differencePaise).toBe(0n);
    expect(cf.operating.find((l) => l.label === 'Receivables')!.paise).toBe(-48_000n);
    expect(cf.operating.find((l) => l.label === 'Payables')!.paise).toBe(27_200n);
    expect(cf.openingCashPaise + cf.netChangePaise).toBe(cf.closingCashPaise);
  });
});

/* ---------------------------------------------------------------------------- property */

const TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'purchase_bill',
  'purchase_return',
  'expense',
] as const;
const docArb: fc.Arbitrary<PostableDocument> = fc
  .record({
    type: fc.constantFrom(...TYPES),
    taxable: fc.integer({ min: 0, max: 10_000_000 }),
    rate: fc.constantFrom(0, 5, 12, 18, 28),
    inter: fc.boolean(),
    cess: fc.integer({ min: 0, max: 50_000 }),
    tcs: fc.integer({ min: 0, max: 20_000 }),
    roundOff: fc.integer({ min: -50, max: 50 }),
    reverseCharge: fc.boolean(),
  })
  .map((r) => {
    const tax = Math.round((r.taxable * r.rate) / 100);
    const half = Math.floor(tax / 2);
    const cgst = r.inter ? 0 : half;
    const sgst = r.inter ? 0 : tax - half;
    const igst = r.inter ? tax : 0;
    const charged = !r.reverseCharge;
    const inward =
      r.type === 'purchase_bill' || r.type === 'purchase_return' || r.type === 'expense';
    const rc = r.reverseCharge && inward;
    const total = r.taxable + (charged ? tax + r.cess : 0) + r.tcs + r.roundOff;
    return {
      type: r.type,
      status: 'issued' as const,
      taxablePaise: BigInt(r.taxable),
      cgstPaise: BigInt(cgst),
      sgstPaise: BigInt(sgst),
      utgstPaise: 0n,
      igstPaise: BigInt(igst),
      cessPaise: BigInt(r.cess),
      tcsPaise: BigInt(r.tcs),
      roundOffPaise: BigInt(r.roundOff),
      totalPaise: BigInt(Math.max(0, total)),
      reverseCharge: rc,
    };
  });
const paymentArb = fc.record({
  direction: fc.constantFrom('received' as const, 'made' as const),
  mode: fc.constantFrom('cash' as const, 'bank' as const, 'upi' as const, 'adjustment' as const),
  amount: fc.integer({ min: 1, max: 5_000_000 }),
  tcs: fc.integer({ min: 0, max: 1_000 }),
});

describe('property: any accepted sequence of documents and payments keeps the books in balance', () => {
  it('the trial balance ties, the balance sheet difference is zero, the cash flow ties', () => {
    fc.assert(
      fc.property(
        fc.array(docArb, { minLength: 1, maxLength: 25 }),
        fc.array(paymentArb, { maxLength: 10 }),
        (docs, pays) => {
          const lines: LedgerLine[] = [];
          for (const d of docs) {
            try {
              lines.push(...postDocument(d));
            } catch {
              // a shape the rules refuse (a negative total, say) is not a posting; that is the point of the rules
            }
          }
          for (const p of pays) {
            try {
              lines.push(
                ...postPayment({
                  direction: p.direction,
                  mode: p.mode,
                  amountPaise: BigInt(p.amount),
                  ...(p.direction === 'received' && p.tcs > 0 && p.tcs < p.amount
                    ? { tcsPaise: BigInt(p.tcs) }
                    : {}),
                }),
              );
            } catch {
              /* refused */
            }
          }
          const sums = sumsOf(lines);
          const tb = trialBalance(accounts, [], sums);
          expect(tb.totals.debitPaise).toBe(tb.totals.creditPaise);
          expect(tb.totals.closingDrPaise).toBe(tb.totals.closingCrPaise);
          expect(balanceSheet(accounts, sums).differencePaise).toBe(0n);
          expect(cashFlow(accounts, sums, []).differencePaise).toBe(0n);
          const closed = closingEntries(accounts, sums, 'retainedEarnings');
          expect(closed.reduce((a, l) => a + l.debitPaise, 0n)).toBe(
            closed.reduce((a, l) => a + l.creditPaise, 0n),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
