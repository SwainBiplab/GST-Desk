/**
 * The ledger over the seeded demo business, on SQLite and Postgres (prompt 50): the trial balance ties and
 * agrees with the registers, the balance sheet's receivables equal the parties' positions, vouchers post,
 * balance and reverse, opening balances and the chart, recurring journals post once per date, the year-end
 * close and reopen, the locked and closed period rules, and the audit that finds and repairs missing postings.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { runInTx, type Ctx } from './base';
import { ACCOUNTS, ChartRepo } from './chart';
import {
  FiscalYearRepo,
  JournalRepo,
  LedgerAudit,
  LedgerReports,
  RecurringJournalRepo,
} from './ledger';
import { PeriodLockRepo } from './period-lock';
import { runReport } from './reports';

const FY = { from: '2024-04-01', to: '2025-03-31' };
const TODAY = '2026-03-31';

for (const dialect of DIALECTS) {
  describe(`ledger (${dialect})`, () => {
    let d: Database;
    let ctx: Ctx;
    let chart: ChartRepo;
    let journal: JournalRepo;
    let reports: LedgerReports;
    const byCode = async (code: string) =>
      (await chart.accounts(ctx)).find((a) => a.code === code)!.id;

    beforeAll(async () => {
      d = await openTestDb(dialect);
      ctx = (await seedDemo(d)).ctx;
      chart = new ChartRepo(d);
      journal = new JournalRepo(d);
      reports = new LedgerReports(d);
      await chart.ensureSystem(ctx);
    }, 120_000);
    afterAll(async () => {
      await d?.close();
    });

    it('the trial balance ties, and its sales equal the sales register net of credit notes', async () => {
      const tb = await reports.trialBalance(ctx, FY);
      expect(tb.totals.closingDrPaise).toBe(tb.totals.closingCrPaise);
      expect(tb.totals.debitPaise).toBe(tb.totals.creditPaise);
      expect(tb.rows.length).toBeGreaterThan(5);
      const sales = tb.rows.find((r) => r.account.code === '4000')!;
      const register = await runReport(d, ctx, 'sales_register', { ...FY, today: TODAY });
      expect(sales.creditPaise - sales.debitPaise).toBe(BigInt(register.totals['taxable'] ?? 0));
      const pl = await reports.profitAndLoss(ctx, FY);
      expect(pl.incomePaise).toBe(BigInt(register.totals['taxable'] ?? 0));
    });

    it('the balance sheet ties and its receivables less payables equal the parties’ positions', async () => {
      const bs = await reports.balanceSheet(ctx, FY.to);
      expect(bs.differencePaise).toBe(0n);
      const audit = await new LedgerAudit(d).verify(ctx, FY.to);
      expect(audit.control.differencePaise).toBe(0n);
      expect(audit.control.ledgerNetPaise).toBe(audit.control.partiesNetPaise);
      expect(audit.documents.missing).toEqual([]);
      expect(audit.documents.unbalanced).toEqual([]);
      expect(audit.payments.missing).toEqual([]);
      // the control figures are as of now (every entry, whatever its date): the balance sheet over everything agrees
      const now = await reports.balanceSheet(ctx, '9999-12-31');
      expect(now.assets.find((g) => g.subGroup === 'receivables')!.paise).toBe(
        audit.control.receivablesLedgerPaise,
      );
    });

    it('a statement runs from the opening balance, and the cash flow ties to cash and bank', async () => {
      const st = await reports.statement(ctx, await byCode('1200'), {
        from: '2024-10-01',
        to: '2024-10-31',
      });
      expect(st.rows.length).toBeGreaterThan(0);
      expect(st.closingPaise).toBe(st.openingPaise + st.debitPaise - st.creditPaise);
      expect(st.rows.at(-1)!.balancePaise).toBe(st.closingPaise);
      expect(st.rows.every((r) => r.source.kind !== 'other')).toBe(true);
      const cf = await reports.cashFlow(ctx, FY);
      expect(cf.differencePaise).toBe(0n);
      const book = await reports.dayBook(ctx, { from: '2024-10-01', to: '2024-10-02' });
      expect(book.length).toBeGreaterThan(0);
      expect(
        book.every(
          (e) =>
            e.lines.reduce((a, l) => a + l.debitPaise, 0n) ===
            e.lines.reduce((a, l) => a + l.creditPaise, 0n),
        ),
      ).toBe(true);
    });

    it('the chart lists the system accounts with their groups, and takes user accounts under them', async () => {
      const all = await chart.accounts(ctx);
      expect(all.find((a) => a.code === ACCOUNTS.outputCgst[0])).toMatchObject({
        type: 'liability',
        subGroup: 'duties_taxes',
        isSystem: true,
      });
      expect(all.find((a) => a.code === ACCOUNTS.retainedEarnings[0])).toBeTruthy();
      const rent = await chart.createAccount(ctx, {
        name: 'Rent',
        type: 'expense',
        subGroup: 'indirect_expenses',
        tallyName: 'Rent Paid',
      });
      expect(rent.code).toBe('6000');
      const salary = await chart.createAccount(ctx, { name: 'Salaries', type: 'expense' });
      expect(salary.code).toBe('6010');
      await expect(
        chart.createAccount(ctx, { name: 'Dup', type: 'expense', code: '6000' }),
      ).rejects.toThrow(/in use/);
      const renamed = await chart.updateAccount(
        ctx,
        rent.id,
        { name: 'Office rent' },
        rent.version,
      );
      expect(renamed.name).toBe('Office rent');
      await expect(chart.archiveAccount(ctx, await byCode('4000'), 1)).rejects.toThrow(/system/);
      await chart.archiveAccount(ctx, salary.id, salary.version);
      expect((await chart.accounts(ctx)).some((a) => a.id === salary.id)).toBe(false);
    });

    it('a journal voucher must balance, posts with a number per year, shows in the statements, and reverses', async () => {
      const rent = (await chart.accounts(ctx)).find((a) => a.name === 'Office rent')!;
      const bank = await byCode('1100');
      await expect(
        journal.post(ctx, {
          date: '2025-06-01',
          lines: [
            { accountId: rent.id, debitPaise: 1_000n, creditPaise: 0n },
            { accountId: bank, debitPaise: 0n, creditPaise: 900n },
          ],
        }),
      ).rejects.toThrow(/does not balance/);
      await expect(
        journal.post(ctx, {
          date: '2025-06-01',
          lines: [
            { accountId: rent.id, debitPaise: 1_000n, creditPaise: 1_000n },
            { accountId: bank, debitPaise: 0n, creditPaise: 0n },
          ],
        }),
      ).rejects.toThrow(/at least two/);
      const v = await journal.post(ctx, {
        date: '2025-06-01',
        narration: 'June rent',
        lines: [
          { accountId: rent.id, debitPaise: 1_000_00n, creditPaise: 0n },
          { accountId: bank, debitPaise: 0n, creditPaise: 1_000_00n },
        ],
      });
      expect(v.number).toBe('JV/25-26/0001');
      expect(v.totalPaise).toBe(100_000n);
      expect(v.lines).toHaveLength(2);
      const v2 = await journal.post(ctx, {
        date: '2025-07-01',
        kind: 'contra',
        lines: [
          { accountId: await byCode('1000'), debitPaise: 500n, creditPaise: 0n },
          { accountId: bank, debitPaise: 0n, creditPaise: 500n },
        ],
      });
      expect(v2.number).toBe('CV/25-26/0001');
      const pl = await reports.profitAndLoss(ctx, { from: '2025-04-01', to: '2026-03-31' });
      expect(pl.expenses.flatMap((g) => g.lines).find((l) => l.account.id === rent.id)!.paise).toBe(
        100_000n,
      );
      const st = await reports.statement(ctx, rent.id, { from: '2025-04-01', to: '2026-03-31' });
      expect(st.rows[0]!.source).toMatchObject({ kind: 'voucher', number: 'JV/25-26/0001' });
      const rv = await journal.reverse(ctx, v.id, 'Posted to the wrong month');
      expect(rv.kind).toBe('reversal');
      expect(rv.lines.find((l) => l.accountId === rent.id)!.creditPaise).toBe(100_000n);
      expect((await journal.voucher(ctx, v.id))!.status).toBe('reversed');
      await expect(journal.reverse(ctx, v.id, 'again')).rejects.toThrow(/already reversed/);
      const after = await reports.profitAndLoss(ctx, { from: '2025-04-01', to: '2026-03-31' });
      expect(
        after.expenses.flatMap((g) => g.lines).find((l) => l.account.id === rent.id),
      ).toBeUndefined();
      expect(
        (await reports.trialBalance(ctx, { from: '2025-04-01', to: '2026-03-31' })).totals
          .closingDrPaise,
      ).toBeGreaterThan(0n);
    });

    it('opening balances post once per year against Opening Balance Equity, and are replaced when entered again', async () => {
      const bank = await byCode('1100');
      const capital = await byCode('3000');
      const v = await journal.setOpening(ctx, '2026-04-01', [
        { accountId: bank, debitPaise: 50_000n, creditPaise: 0n },
        { accountId: capital, debitPaise: 0n, creditPaise: 20_000n },
      ]);
      expect(v.kind).toBe('opening');
      expect(v.lines.find((l) => l.code === '3100')!.creditPaise).toBe(30_000n);
      const again = await journal.setOpening(ctx, '2026-04-01', [
        { accountId: bank, debitPaise: 60_000n, creditPaise: 0n },
      ]);
      expect((await journal.voucher(ctx, v.id))!.status).toBe('reversed');
      const bs = await reports.balanceSheet(ctx, '2026-04-01');
      expect(bs.differencePaise).toBe(0n);
      expect(again.lines.find((l) => l.code === '3100')!.creditPaise).toBe(60_000n);
    });

    it('a recurring journal posts once per due date, never twice, and advances', async () => {
      const rent = (await chart.accounts(ctx)).find((a) => a.name === 'Office rent')!;
      const bank = await byCode('1100');
      const rj = new RecurringJournalRepo(d);
      const r = await rj.createRecurring(ctx, {
        name: 'Monthly rent',
        every: 'monthly',
        day: 5,
        startDate: '2025-08-05',
        lines: [
          { accountId: rent.id, debitPaise: 25_000n, creditPaise: 0n },
          { accountId: bank, debitPaise: 0n, creditPaise: 25_000n },
        ],
      });
      const first = await rj.postDue(ctx, '2025-10-06');
      expect(first.posted).toBe(3); // August, September, October
      const second = await rj.postDue(ctx, '2025-10-06');
      expect(second.posted).toBe(0);
      const list = await journal.vouchers(ctx, { kind: 'recurring' });
      expect(list.map((v) => v.date).sort()).toEqual(['2025-08-05', '2025-09-05', '2025-10-05']);
      const updated = (await rj.all(ctx)).find((x) => x.id === r.id)!;
      expect(updated.nextDate).toBe('2025-11-05');
      await rj.updateRecurring(ctx, r.id, { active: false }, updated.version);
      expect((await rj.postDue(ctx, '2026-01-01')).posted).toBe(0);
    });

    it('a locked period refuses a voucher unless an owner gives a reason', async () => {
      const lock = new PeriodLockRepo(d);
      await lock.set(ctx, '2024-06-30');
      const bank = await byCode('1100');
      const cash = await byCode('1000');
      const lines = [
        { accountId: cash, debitPaise: 100n, creditPaise: 0n },
        { accountId: bank, debitPaise: 0n, creditPaise: 100n },
      ];
      await expect(journal.post(ctx, { date: '2024-05-01', lines })).rejects.toThrow(/locked/);
      await expect(
        journal.post(
          { ...ctx, role: 'accountant' },
          { date: '2024-05-01', lines, lockOverride: { reason: 'x' } },
        ),
      ).rejects.toThrow(/owner/);
      const v = await journal.post(ctx, {
        date: '2024-05-01',
        lines,
        lockOverride: { reason: 'late bank charge' },
      });
      expect(v.id).toBeTruthy();
      await lock.set(ctx, null, 'test over');
    });

    it('closing a year zeroes the P&L into retained earnings, locks the books, and an owner reopens with a reason', async () => {
      const fy = new FiscalYearRepo(d);
      const years = await fy.years(ctx);
      expect(years.map((y) => y.label)).toContain('24-25');
      const before = await reports.profitAndLoss(ctx, FY);
      const closed = await fy.close(ctx, '2024-04-01');
      expect(closed.status).toBe('closed');
      expect(closed.closingVoucherId).toBeTruthy();
      const voucher = (await journal.voucher(ctx, closed.closingVoucherId!))!;
      expect(voucher.kind).toBe('closing');
      expect(voucher.number).toBe('CL/24-25/0001');
      // the P&L of the year still reads as before (the closing voucher is left out), the balance sheet ties,
      // and the profit now sits in retained earnings
      const after = await reports.profitAndLoss(ctx, FY);
      expect(after.netPaise).toBe(before.netPaise);
      const bs = await reports.balanceSheet(ctx, FY.to);
      expect(bs.differencePaise).toBe(0n);
      expect(bs.equity.find((g) => g.subGroup === 'reserves')!.paise).toBe(before.netPaise);
      expect(bs.unclosedProfitPaise).toBe(0n);
      expect((await new PeriodLockRepo(d).get(ctx))!.until).toBe(FY.to);
      await expect(
        journal.post(ctx, {
          date: '2024-12-01',
          lines: [
            { accountId: await byCode('1000'), debitPaise: 1n, creditPaise: 0n },
            { accountId: await byCode('1100'), debitPaise: 0n, creditPaise: 1n },
          ],
          lockOverride: { reason: 'r' },
        }),
      ).rejects.toThrow(/closed/);
      await expect(fy.close(ctx, '2024-04-01')).rejects.toThrow(/already closed/);
      await expect(fy.reopen({ ...ctx, role: 'accountant' }, '2024-04-01', 'why')).rejects.toThrow(
        /owner/,
      );
      await expect(fy.reopen(ctx, '2024-04-01', '')).rejects.toThrow(/why/);
      const reopened = await fy.reopen(ctx, '2024-04-01', 'An invoice was missed');
      expect(reopened.status).toBe('open');
      expect(reopened.reopenReason).toBe('An invoice was missed');
      expect((await journal.voucher(ctx, closed.closingVoucherId!))!.status).toBe('reversed');
      expect((await reports.balanceSheet(ctx, FY.to)).unclosedProfitPaise).toBe(before.netPaise);
      expect(await new PeriodLockRepo(d).get(ctx)).toBeNull();
      const audit = await runInTx<Record<string, unknown>[]>(d, ctx, (tx) =>
        tx
          .select()
          .from(d.schema.audit_log)
          .where(eq(d.schema.audit_log.table_name, 'fiscal_year')),
      );
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });

    it('the audit finds a document and a payment without postings and repairs them with the rules', async () => {
      const le = d.schema.ledger_entries;
      const docs = d.schema.documents;
      const pays = d.schema.payments;
      // take one issued invoice's and one cleared payment's entries away, as a crash mid-issue might have
      const [doc, pay] = await runInTx(d, ctx, async (tx) => {
        const [dd] = await tx
          .select()
          .from(docs)
          .where(
            and(
              eq(docs.business_id, ctx.businessId),
              eq(docs.type, 'tax_invoice'),
              eq(docs.status, 'issued'),
            ),
          )
          .limit(1);
        const [pp] = await tx
          .select()
          .from(pays)
          .where(and(eq(pays.business_id, ctx.businessId), eq(pays.status, 'cleared')))
          .limit(1);
        await tx.update(le).set({ deleted_at: Date.now() }).where(eq(le.document_id, dd!['id']));
        await tx.update(le).set({ deleted_at: Date.now() }).where(eq(le.payment_id, pp!['id']));
        return [dd, pp];
      });
      const audit = new LedgerAudit(d);
      const found = await audit.verify(ctx, TODAY);
      expect(found.documents.missing).toEqual([doc!['id']]);
      expect(found.payments.missing).toEqual([pay!['id']]);
      expect(found.control.differencePaise).not.toBe(0n);
      const fixed = await audit.repair(ctx, TODAY);
      expect(fixed).toEqual({ documents: 1, payments: 1 });
      const again = await audit.verify(ctx, TODAY);
      expect(again.documents.missing).toEqual([]);
      expect(again.payments.missing).toEqual([]);
      expect(again.control.differencePaise).toBe(0n);
      expect(
        (await reports.trialBalance(ctx, { from: '2024-04-01', to: TODAY })).totals.closingDrPaise,
      ).toBeGreaterThan(0n);
    });
  });
}
