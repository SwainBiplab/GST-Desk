import { netTurnoverPaise, purchaseSign, type DocumentType } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { DocumentRepo, LedgerRepo } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { PaymentFlowRepo } from './payment-flow';
import {
  REPORTS,
  REPORT_IDS,
  exportReport,
  getDashboard,
  runReport,
  type ReportParams,
} from './reports';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

const ALL: ReportParams = { from: '2024-04-01', to: '2026-03-31', today: '2026-03-31' };

describe.each(DIALECTS)('reports on the seeded book (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let docs: Record<string, any>[];

  beforeAll(async () => {
    d = await openTestDb(dialect);
    opened.push(d);
    ({ ctx } = await seedDemo(d, { documents: 400, parties: 30, items: 60 }));
    docs = await new DocumentRepo(d).list(ctx);
  }, 120_000);

  it('the sales register counts exactly the issued turnover documents, credit notes as minus', async () => {
    const r = await runReport(d, ctx, 'sales_register', ALL);
    const expected = netTurnoverPaise(
      docs.map((x) => ({
        type: x['type'] as DocumentType,
        status: x['status'],
        taxablePaise: BigInt(x['total_taxable_paise']),
      })),
    );
    expect(BigInt(r.totals['taxable']!)).toBe(expected);
    const inRegister = new Set(r.rows.map((x) => x['type']));
    for (const t of ['proforma', 'quotation', 'delivery_challan', 'purchase_bill', 'expense']) {
      expect(inRegister.has(t), `${t} must not be in the sales register`).toBe(false);
    }
    // no draft or cancelled document sneaks in
    const ids = new Set(r.rows.map((x) => x['id']));
    for (const x of docs) {
      if (x['status'] !== 'issued') expect(ids.has(x['id'])).toBe(false);
    }
    expect(r.count).toBe(r.rows.length);
    expect(r.rows.some((x) => Number(x['taxable']) < 0)).toBe(true); // credit notes subtract
  });

  it('sales register = GST summary (outward) = HSN summary = ledger sales', async () => {
    const register = await runReport(d, ctx, 'sales_register', ALL);
    const gst = await runReport(d, ctx, 'gst_summary', { ...ALL, type: 'outward' });
    const hsn = await runReport(d, ctx, 'hsn_summary', ALL);
    expect(gst.totals['taxable']).toBe(register.totals['taxable']);
    expect(hsn.totals['taxable']).toBe(register.totals['taxable']);

    const tax = (t: Record<string, number>) =>
      (t['cgst'] ?? 0) + (t['sgst'] ?? 0) + (t['igst'] ?? 0) + (t['cess'] ?? 0);
    expect(gst.totals['tax']).toBe(tax(register.totals));
    expect(tax(hsn.totals)).toBe(tax(register.totals));

    const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
    const sales = accounts.find((a) => a['code'] === '4000')!['id'];
    const tb = await new LedgerRepo(d).trialBalance(ctx, { from: ALL.from, to: ALL.to });
    const row = tb.find((x) => x.account_id === sales)!;
    // Sales is credited by invoices and debited by credit notes: the register's net taxable
    expect(row.credit_paise - row.debit_paise).toBe(register.totals['taxable']);
  });

  it('purchase register nets returns off, and matches the GST summary (inward)', async () => {
    const r = await runReport(d, ctx, 'purchase_register', ALL);
    let expected = 0n;
    for (const x of docs) {
      expected += BigInt(purchaseSign(x['type'], x['status'])) * BigInt(x['total_taxable_paise']);
    }
    expect(BigInt(r.totals['taxable']!)).toBe(expected);
    const gst = await runReport(d, ctx, 'gst_summary', { ...ALL, type: 'inward' });
    expect(gst.totals['taxable']).toBe(r.totals['taxable']);
  });

  it('pages of a register add up to the whole, in order, with the same totals', async () => {
    const whole = await runReport(d, ctx, 'sales_register', ALL);
    const rows: unknown[] = [];
    for (let offset = 0; offset < whole.count; offset += 37) {
      const page = await runReport(d, ctx, 'sales_register', ALL, { offset, limit: 37 });
      expect(page.totals).toEqual(whole.totals);
      rows.push(...page.rows);
    }
    expect(rows).toEqual(whole.rows);
  });

  it('filters by period, party and type', async () => {
    const all = await runReport(d, ctx, 'sales_register', ALL);
    const q1 = await runReport(d, ctx, 'sales_register', {
      ...ALL,
      from: '2024-04-01',
      to: '2024-06-30',
    });
    expect(q1.count).toBeGreaterThan(0);
    expect(q1.count).toBeLessThan(all.count);
    expect(q1.rows.every((x) => String(x['date']) <= '2024-06-30')).toBe(true);

    const party = docs.find((x) => x['status'] === 'issued' && x['type'] === 'tax_invoice')!;
    const one = await runReport(d, ctx, 'sales_register', { ...ALL, partyId: party['party_id'] });
    expect(one.count).toBeGreaterThan(0);
    expect(one.rows.every((x) => x['party'] === party['party_name'])).toBe(true);

    const invoices = await runReport(d, ctx, 'sales_register', { ...ALL, type: 'tax_invoice' });
    expect(invoices.rows.every((x) => x['type'] === 'tax_invoice')).toBe(true);
    // a type the report does not cover is ignored, never widened
    const bogus = await runReport(d, ctx, 'sales_register', { ...ALL, type: 'purchase_bill' });
    expect(bogus.count).toBe(all.count);
  });

  it('the note register lists credit and debit notes with their own signs', async () => {
    const r = await runReport(d, ctx, 'note_register', ALL);
    const issued = docs.filter(
      (x) =>
        x['status'] === 'issued' && (x['type'] === 'credit_note' || x['type'] === 'debit_note'),
    );
    expect(r.count).toBe(issued.length);
    expect(r.rows.every((x) => Number(x['total']) > 0)).toBe(true);
  });

  it('the document summary counts issued and cancelled numbers per series', async () => {
    const r = await runReport(d, ctx, 'document_summary', ALL);
    const numbered = docs.filter(
      (x) =>
        (x['status'] === 'issued' || x['status'] === 'cancelled') &&
        x['number'] &&
        ['tax_invoice', 'bill_of_supply', 'debit_note', 'credit_note'].includes(x['type']),
    );
    const sum = (k: string, types: string[]) =>
      r.rows.filter((x) => types.includes(String(x['type']))).reduce((a, x) => a + Number(x[k]), 0);
    const types = ['tax_invoice', 'bill_of_supply', 'debit_note', 'credit_note'];
    expect(sum('total', types)).toBe(numbered.length);
    expect(sum('cancelled', types)).toBe(
      numbered.filter((x) => x['status'] === 'cancelled').length,
    );
    for (const row of r.rows) {
      expect(Number(row['net'])).toBe(Number(row['total']) - Number(row['cancelled']));
      expect(String(row['from']).length).toBeGreaterThan(0);
    }
    // numbers order by their serial, not as text: from <= to in that order
    const serial = (s: string) => Number(/(\d+)\D*$/.exec(s)![1]);
    for (const row of r.rows)
      expect(serial(String(row['from']))).toBeLessThanOrEqual(serial(String(row['to'])));
  });

  it('party outstanding agrees with every party position of the payment engine', async () => {
    const flow = new PaymentFlowRepo(d);
    const r = await runReport(d, ctx, 'party_outstanding', { ...ALL, side: 'all' });
    const byId = new Map(r.rows.map((x) => [String(x['id']), x]));
    const parties = await new BaseRepo(d, 'parties').list(ctx);
    let checked = 0;
    for (const p of parties) {
      const pos = await flow.partyPosition(ctx, p['id'], ALL.today);
      const row = byId.get(p['id']);
      expect(Number(row?.['outstanding'] ?? 0), String(p['name'])).toBe(
        Number(pos.outstandingPaise),
      );
      expect(Number(row?.['credit'] ?? 0)).toBe(Number(pos.creditPaise));
      checked++;
    }
    expect(checked).toBe(parties.length);
    // ageing buckets add up to the documents figure
    for (const row of r.rows) {
      const docsTotal =
        Number(row['notDue']) +
        Number(row['d1_30']) +
        Number(row['d31_60']) +
        Number(row['d61_90']) +
        Number(row['d90plus']);
      expect(Number(row['opening']) + docsTotal - Number(row['credit'])).toBe(
        Number(row['outstanding']),
      );
    }
  }, 120_000);

  it('receivables and payables match the sum over parties', async () => {
    const summary = await runReport(d, ctx, 'receivables_payables', ALL);
    const flow = new PaymentFlowRepo(d);
    const { documents } = await flow.positions(ctx, ALL.today);
    let rec = 0n;
    let pay = 0n;
    for (const x of documents) {
      if (['tax_invoice', 'bill_of_supply', 'debit_note'].includes(x.type)) rec += x.balancePaise;
      else pay += x.balancePaise;
    }
    const bucketRows = summary.rows.filter(
      (x) => !['opening', 'credit'].includes(String(x['bucket'])),
    );
    expect(bucketRows.reduce((a, x) => a + Number(x['receivable']), 0)).toBe(Number(rec));
    expect(bucketRows.reduce((a, x) => a + Number(x['payable']), 0)).toBe(Number(pay));
  });

  it('receipts and payments total what was cleared, and split cash from bank', async () => {
    const all = await runReport(d, ctx, 'receipts_payments', ALL);
    const cash = await runReport(d, ctx, 'receipts_payments', { ...ALL, book: 'cash' });
    const bank = await runReport(d, ctx, 'receipts_payments', { ...ALL, book: 'bank' });
    const payments = await new BaseRepo(d, 'payments').list(ctx);
    const cleared = payments.filter((x) => x['status'] === 'cleared');
    const sum = (rows: Record<string, any>[], dir: string) =>
      rows.filter((x) => x['direction'] === dir).reduce((a, x) => a + Number(x['amount_paise']), 0);
    expect(all.totals['receipt']).toBe(sum(cleared, 'received'));
    expect(all.totals['payment']).toBe(sum(cleared, 'made'));
    expect(cash.totals['receipt']! + bank.totals['receipt']!).toBe(all.totals['receipt']);
    expect(cash.rows.every((x) => x['mode'] === 'cash')).toBe(true);
  });

  it('the day book interleaves documents and payments by date', async () => {
    const r = await runReport(d, ctx, 'day_book', ALL, { offset: 0, limit: 200 });
    expect(r.count).toBeGreaterThan(200);
    const dates = r.rows.map((x) => String(x['date']));
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(r.rows.map((x) => x['kind'])).size).toBeGreaterThan(2);
    expect(r.rows.some((x) => x['kind'] === 'receipt' || x['kind'] === 'payment')).toBe(true);
  });

  it('expense, party-wise, item-wise and stock reports run and add up', async () => {
    const expense = await runReport(d, ctx, 'expense_summary', ALL);
    const expenseDocs = docs.filter((x) => x['status'] === 'issued' && x['type'] === 'expense');
    expect(expense.totals['total']).toBe(
      expenseDocs.reduce((a, x) => a + Number(x['total_paise']) - Number(x['round_off_paise']), 0) -
        // lines carry the total before round-off and before document-level TCS
        expenseDocs.reduce((a, x) => a + Number(x['tcs_paise']), 0),
    );

    const parties = await runReport(d, ctx, 'party_sales', ALL);
    const register = await runReport(d, ctx, 'sales_register', ALL);
    expect(parties.totals['sales']).toBe(register.totals['taxable']);

    const items = await runReport(d, ctx, 'item_sales', ALL);
    expect(items.totals['taxable']).toBe(register.totals['taxable']);

    const stock = await runReport(d, ctx, 'stock_summary', ALL);
    expect(stock.rows.length).toBeGreaterThan(0);
    for (const row of stock.rows) {
      expect(Number(row['closing'])).toBe(
        Number(row['opening']) + Number(row['in']) - Number(row['out']),
      );
    }
  });

  it('every report in the catalogue runs, and returns the columns it declares', async () => {
    for (const id of REPORT_IDS) {
      const r = await runReport(
        d,
        ctx,
        id,
        ALL,
        REPORTS[id].paged ? { offset: 0, limit: 10 } : undefined,
      );
      const keys = new Set(REPORTS[id].columns.map((c) => c.key));
      for (const row of r.rows.slice(0, 5)) {
        for (const k of keys) expect(row, `${id}.${k}`).toHaveProperty(k);
      }
      for (const k of Object.keys(r.totals)) expect(keys.has(k), `${id} total ${k}`).toBe(true);
    }
  });

  it('exports every row in batches, equal to the whole report', async () => {
    const whole = await runReport(d, ctx, 'sales_register', ALL);
    const seen: unknown[] = [];
    const sent = await exportReport(
      d,
      ctx,
      'sales_register',
      ALL,
      (rows) => {
        seen.push(...rows);
      },
      40,
    );
    expect(sent).toBe(whole.count);
    expect(seen).toEqual(whole.rows);
  });

  it('is scoped to the business: another business sees nothing', async () => {
    const other: Ctx = { ...ctx, businessId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    const r = await runReport(d, other, 'sales_register', ALL);
    expect(r.count).toBe(0);
    expect(r.totals['total']).toBe(0);
  });

  it('the dashboard numbers match the reports they open', async () => {
    const day = '2025-09-15';
    const dash = await getDashboard(d, ctx, day);
    const today = await runReport(d, ctx, 'sales_register', { from: day, to: day, today: day });
    expect(dash.salesTodayPaise).toBe(today.totals['total']);
    expect(dash.billsToday).toBe(
      today.rows.filter((x) => x['type'] !== 'credit_note' && x['type'] !== 'debit_note').length,
    );

    // "to collect" and "to pay" are the totals of the Party outstanding report they open
    const owed = await runReport(d, ctx, 'party_outstanding', {
      ...ALL,
      today: day,
      side: 'receivable',
    });
    const owing = await runReport(d, ctx, 'party_outstanding', {
      ...ALL,
      today: day,
      side: 'payable',
    });
    expect(dash.receivablesPaise).toBe(owed.totals['outstanding']);
    expect(dash.payablesPaise).toBe(owing.totals['outstanding']);
    const ageing = Object.values(dash.receivablesAgeing).reduce((a, b) => a + b, 0);
    expect(ageing).toBe(
      (owed.totals['notDue'] ?? 0) +
        (owed.totals['d1_30'] ?? 0) +
        (owed.totals['d31_60'] ?? 0) +
        (owed.totals['d61_90'] ?? 0) +
        (owed.totals['d90plus'] ?? 0),
    );

    const month = await runReport(d, ctx, 'sales_register', {
      from: '2025-09-01',
      to: day,
      today: day,
    });
    expect(dash.monthSalesPaise).toBe(month.totals['total']);
    const purchases = await runReport(d, ctx, 'purchase_register', {
      from: '2025-09-01',
      to: day,
      today: day,
    });
    const expenses = await runReport(d, ctx, 'expense_summary', {
      from: '2025-09-01',
      to: day,
      today: day,
    });
    const expenseDocs = docs.filter(
      (x) =>
        x['status'] === 'issued' &&
        x['type'] === 'expense' &&
        x['date'] >= '2025-09-01' &&
        x['date'] <= day,
    );
    expect(dash.monthSpendPaise).toBe(
      purchases.totals['total']! + expenseDocs.reduce((a, x) => a + Number(x['total_paise']), 0),
    );
    expect(expenses.count).toBeGreaterThanOrEqual(0);
    const lastMonth = await runReport(d, ctx, 'sales_register', {
      from: '2025-08-01',
      to: '2025-08-15',
      today: day,
    });
    expect(dash.lastMonthSalesPaise).toBe(lastMonth.totals['total']);

    const gst = await runReport(d, ctx, 'gst_summary', {
      from: '2025-09-01',
      to: '2025-09-30',
      today: day,
      type: 'outward',
    });
    expect(dash.gstEstimate.outputPaise).toBe(gst.totals['tax']);
    expect(dash.overdue.length).toBeLessThanOrEqual(5);
    for (const o of dash.overdue) expect(o.daysOverdue).toBeGreaterThan(0);
    expect(dash.filing.length).toBeGreaterThan(0);
    expect(dash.drafts).toBe(docs.filter((x) => x['status'] === 'draft').length);
  });
});
