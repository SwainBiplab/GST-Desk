import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from './database';
import { announce } from './events';
import {
  BusinessRepo,
  DocumentRepo,
  PaymentRepo,
  createOrganisation,
} from './repositories/aggregates';
import { BaseRepo, RuleError, runInTx, type Ctx } from './repositories/base';
import { computeLine } from './repositories/line-math';
import {
  PartyRepo,
  ReminderRepo,
  getPartyAccount,
  getPartyAccounts,
  getPartyStatement,
} from './repositories/parties';
import { seedDemo } from './seed';
import { DIALECTS, openTestDb } from './testing/harness';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function tenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

const line = {
  qty_micros: 1_000_000,
  rate_paise: 100_000,
  discount_mode: 'none',
  discount_value: 0,
  cgst_bp: 900,
  sgst_bp: 900,
};
const calc = computeLine(line);
const invoice = (date: string, partyId: string, extra: Record<string, unknown> = {}) => ({
  type: 'tax_invoice',
  date,
  due_date: date,
  party_id: partyId,
  total_taxable_paise: calc.taxable_paise,
  total_cgst_paise: calc.cgst_paise,
  total_sgst_paise: calc.sgst_paise,
  total_paise: calc.total_paise,
  ...extra,
});

async function issued(d: Database, ctx: Ctx, partyId: string, date: string, number: string) {
  const docs = new DocumentRepo(d);
  const c = await docs.createWithLines(ctx, invoice(date, partyId), [{ ...line, ...calc }]);
  return docs.issue(ctx, c.document['id'], 1, number);
}

describe.each(DIALECTS)('opening balances (%s)', (dialect) => {
  it('posts balanced ledger entries on create and the difference on update', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    const parties = new PartyRepo(d);
    const p = await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma',
      opening_balance_paise: 50_000,
      opening_balance_date: '2026-04-01',
    });
    const ledger = new BaseRepo(d, 'ledger_entries');
    const rows = await ledger.list(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((a, r) => a + r['debit_paise'], 0)).toBe(50_000);
    expect(rows.reduce((a, r) => a + r['credit_paise'], 0)).toBe(50_000);
    expect(rows.every((r) => r['party_id'] === p['id'] && r['date'] === '2026-04-01')).toBe(true);

    await parties.update(ctx, p['id'], { opening_balance_paise: 80_000 }, p['version']);
    const after = await ledger.list(ctx);
    expect(after).toHaveLength(4);
    expect(after.reduce((a, r) => a + r['debit_paise'] - r['credit_paise'], 0)).toBe(0); // still balanced
    const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
    const rec = accounts.find((a) => a['code'] === '1200')!;
    const net = after
      .filter((r) => r['account_id'] === rec['id'])
      .reduce((a, r) => a + r['debit_paise'] - r['credit_paise'], 0);
    expect(net).toBe(80_000); // receivables carry the whole opening balance

    // a zero opening balance posts nothing; a negative one credits payables
    await parties.create(ctx, { type: 'supplier', name: 'Free' });
    expect(await ledger.list(ctx)).toHaveLength(4);
    await parties.create(ctx, { type: 'supplier', name: 'We owe', opening_balance_paise: -900 });
    const payables = accounts.find((a) => a['code'] === '2000')!;
    const all = await ledger.list(ctx);
    expect(
      all
        .filter((r) => r['account_id'] === payables['id'])
        .reduce((a, r) => a + r['credit_paise'], 0),
    ).toBe(900);
  }, 60_000);
});

describe.each(DIALECTS)('party accounts (%s)', (dialect) => {
  it('computes balance, overdue and ageing, and the statement agrees with them', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    const p = await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'Iyer',
      opening_balance_paise: 10_000,
      opening_balance_date: '2026-01-01',
    });
    const old = await issued(d, ctx, p['id'], '2026-01-10', 'INV-1');
    await issued(d, ctx, p['id'], '2026-05-20', 'INV-2');
    const payments = new PaymentRepo(d);
    await payments.record(
      ctx,
      { date: '2026-02-01', mode: 'upi', amount_paise: 60_000, party_id: p['id'] },
      [{ document_id: old['id'], amount_paise: 60_000 }],
    );
    // a bounced payment and a pending one must not count
    await payments.record(ctx, {
      date: '2026-02-02',
      mode: 'cheque',
      amount_paise: 99_999,
      party_id: p['id'],
      status: 'bounced',
    });
    await payments.record(ctx, {
      date: '2026-02-03',
      mode: 'cheque',
      amount_paise: 88_888,
      party_id: p['id'],
      status: 'pending',
    });

    const acc = await getPartyAccount(d, ctx, p['id'], '2026-06-30');
    expect(acc.balancePaise).toBe(10_000n + 2n * 118_000n - 60_000n);
    expect(acc.lastPaymentDate).toBe('2026-02-01');
    expect(acc.documentCount).toBe(2);
    expect(acc.ageing.totalDuePaise).toBe(acc.balancePaise);
    // 70,000 of credit clears the opening balance and part of INV-1; INV-2 (due 2026-05-20) is 41 days late
    expect(acc.ageing.d31_60).toBe(118_000n);
    expect(acc.overduePaise).toBe(acc.ageing.overduePaise);
    expect(acc.documentDue.get(old['id'])).toBe(118_000n - 60_000n);

    const st = await getPartyStatement(d, ctx, p['id']);
    expect(st.closingBalancePaise).toBe(acc.balancePaise);
    expect(st.lines.map((l) => l.kind)).toEqual(['opening', 'document', 'payment', 'document']);
    const ranged = await getPartyStatement(d, ctx, p['id'], {
      from: '2026-02-01',
      to: '2026-06-30',
    });
    expect(ranged.openingBalancePaise).toBe(10_000n + 118_000n);
    expect(ranged.closingBalancePaise).toBe(acc.balancePaise);
  }, 60_000);

  it('excludes drafts and cancelled documents', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    const p = await new PartyRepo(d).create(ctx, { type: 'customer', name: 'A' });
    const docs = new DocumentRepo(d);
    await docs.createWithLines(ctx, invoice('2026-05-01', p['id']), [{ ...line, ...calc }]); // draft
    const c = await issued(d, ctx, p['id'], '2026-05-02', 'X-1');
    await docs.cancel(ctx, c['id'], c['version'], 'mistake');
    expect((await getPartyAccount(d, ctx, p['id'], '2026-06-01')).balancePaise).toBe(0n);
  }, 60_000);

  it('the statement balance equals the outstanding in the list for every seeded party', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx } = await seedDemo(d, { documents: 150, parties: 20, items: 30 });
    const summary = await getPartyAccounts(d, ctx, '2026-06-30');
    expect(summary.size).toBe(20);
    let nonZero = 0;
    for (const [id, acc] of summary) {
      const st = await getPartyStatement(d, ctx, id);
      expect(st.closingBalancePaise, id).toBe(acc.balancePaise);
      expect(acc.ageing.totalDuePaise, id).toBe(
        acc.balancePaise < 0n ? -acc.balancePaise : acc.balancePaise,
      );
      if (acc.balancePaise !== 0n) nonZero += 1;
    }
    expect(nonZero).toBeGreaterThan(5);
  }, 120_000);

  it('reports not found for another business', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const a = await tenant(d);
    const b = await tenant(d);
    const p = await new PartyRepo(d).create(a, { type: 'customer', name: 'Only A' });
    await expect(getPartyAccount(d, b, p['id'], '2026-01-01')).rejects.toThrow(/not found/);
  }, 60_000);
});

describe.each(DIALECTS)('merging parties (%s)', (dialect) => {
  async function scenario(d: Database) {
    const ctx = await tenant(d);
    const parties = new PartyRepo(d);
    const target = await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma Traders',
      gstin: '27AAPFU0939F1ZV',
      tags_json: ['vip'],
      credit_days: 15,
    });
    const source = await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma Traders Pvt Ltd',
      phone: '9876543210',
      city: 'Pune',
      tags_json: ['wholesale'],
      credit_days: 30,
      opening_balance_paise: 20_000,
      opening_balance_date: '2026-04-01',
      notes: 'pays late',
      addresses_json: [{ kind: 'billing', line1: '1 Road' }],
    });
    const doc = await issued(d, ctx, source['id'], '2026-05-01', 'INV-1');
    await new PaymentRepo(d).record(ctx, {
      date: '2026-05-05',
      mode: 'cash',
      amount_paise: 5_000,
      party_id: source['id'],
    });
    await new ReminderRepo(d).create(ctx, {
      party_id: source['id'],
      channel: 'manual',
      message: 'hi',
      sent_at: Date.now(),
    });
    return { ctx, parties, target, source, doc };
  }

  it('moves documents, payments and reminders, merges fields and archives the source', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, parties, target, source } = await scenario(d);
    const before = (await getPartyAccount(d, ctx, source['id'], '2026-06-30')).balancePaise;

    const rec = await parties.merge(ctx, source['id'], target['id']);
    expect(rec.moved.documents).toHaveLength(1);
    expect(rec.moved.payments).toHaveLength(1);
    expect(rec.moved.reminders).toHaveLength(1);
    expect(rec.moved.ledger_entries).toHaveLength(2); // the opening-balance postings

    expect(await parties.get(ctx, source['id'])).toBeNull();
    const merged = (await parties.get(ctx, target['id']))!;
    expect(merged).toMatchObject({
      gstin: '27AAPFU0939F1ZV',
      phone: '9876543210',
      city: 'Pune',
      credit_days: 30,
      opening_balance_paise: 20_000,
      opening_balance_date: '2026-04-01',
    });
    expect(merged['tags_json']).toEqual(['vip', 'wholesale']);
    expect(merged['notes']).toBe('pays late');
    expect(merged['addresses_json']).toEqual([{ kind: 'billing', line1: '1 Road' }]);

    // the target now carries everything, and the ledger still balances overall
    expect((await getPartyAccount(d, ctx, target['id'], '2026-06-30')).balancePaise).toBe(before);
    const ledger = await new BaseRepo(d, 'ledger_entries').list(ctx);
    expect(ledger.reduce((a, r) => a + r['debit_paise'] - r['credit_paise'], 0)).toBe(0);
    const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
    const rec1200 = accounts.find((a) => a['code'] === '1200')!;
    expect(
      ledger
        .filter((r) => r['account_id'] === rec1200['id'])
        .reduce((a, r) => a + r['debit_paise'] - r['credit_paise'], 0),
    ).toBe(20_000);
    expect((await new PartyRepo(d).search(ctx, 'sharma')).map((p) => p['id'])).toEqual([
      target['id'],
    ]);
  }, 60_000);

  it('audits the merge and refuses merging a party into itself', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, parties, target, source, doc } = await scenario(d);
    await expect(parties.merge(ctx, target['id'], target['id'])).rejects.toBeInstanceOf(RuleError);
    await parties.merge(ctx, source['id'], target['id']);
    const { AuditRepo } = await import('./repositories/aggregates');
    const trail = await new AuditRepo(d).forRow(ctx, 'documents', doc['id']);
    const last = trail.at(-1)!;
    expect(last['action']).toBe('update');
    expect(last['before_json'].party_id).toBe(source['id']);
    expect(last['after_json'].party_id).toBe(target['id']);
    const partyTrail = await new AuditRepo(d).forRow(ctx, 'parties', source['id']);
    expect(partyTrail.at(-1)!['action']).toBe('soft_delete');
  }, 60_000);

  it('undoes a merge completely', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, parties, target, source } = await scenario(d);
    const srcBalance = (await getPartyAccount(d, ctx, source['id'], '2026-06-30')).balancePaise;
    const tgtBalance = (await getPartyAccount(d, ctx, target['id'], '2026-06-30')).balancePaise;
    const rec = await parties.merge(ctx, source['id'], target['id']);
    await parties.undoMerge(ctx, rec);

    const restored = (await parties.get(ctx, source['id']))!;
    expect(restored).toMatchObject({
      name: 'Sharma Traders Pvt Ltd',
      opening_balance_paise: 20_000,
    });
    const tgt = (await parties.get(ctx, target['id']))!;
    expect(tgt).toMatchObject({
      phone: null,
      city: null,
      credit_days: 15,
      opening_balance_paise: 0,
      notes: null,
    });
    expect(tgt['tags_json']).toEqual(['vip']);
    expect((await getPartyAccount(d, ctx, source['id'], '2026-06-30')).balancePaise).toBe(
      srcBalance,
    );
    expect((await getPartyAccount(d, ctx, target['id'], '2026-06-30')).balancePaise).toBe(
      tgtBalance,
    );
    expect(await new ReminderRepo(d).forParty(ctx, source['id'])).toHaveLength(1);
    expect((await new PartyRepo(d).search(ctx, 'pvt')).map((p) => p['id'])).toEqual([source['id']]);
    // the ledger is balanced after the round trip
    const ledger = await new BaseRepo(d, 'ledger_entries').list(ctx);
    expect(ledger.reduce((a, r) => a + r['debit_paise'] - r['credit_paise'], 0)).toBe(0);
    // undoing twice is refused
    await expect(parties.undoMerge(ctx, rec)).rejects.toBeInstanceOf(RuleError);
  }, 60_000);

  it('lists parties in the lite form for duplicate checks', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, parties, target } = await scenario(d);
    const lite = await parties.listLite(ctx);
    expect(lite).toHaveLength(2);
    expect(lite.find((p) => p.id === target['id'])).toEqual({
      id: target['id'],
      name: 'Sharma Traders',
      gstin: '27AAPFU0939F1ZV',
      phone: null,
    });
    announce(d, ['parties']);
  }, 60_000);
});

describe('performance', () => {
  it('searches 5,000 parties in under 100 ms (SQLite FTS5)', async () => {
    const d = await openTestDb('sqlite');
    opened.push(d);
    const ctx = await tenant(d);
    const now = Date.now();
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: crypto.randomUUID(),
      org_id: ctx.orgId,
      business_id: ctx.businessId,
      version: 1,
      created_at: now,
      updated_at: now,
      type: 'customer',
      name: `${['Sharma', 'Iyer', 'Patel', 'Reddy', 'Khan'][i % 5]} ${['Traders', 'Stores', 'Agencies'][i % 3]} ${i}`,
      gstin: i % 7 === 0 ? `27AAPFU${String(1000 + i).padStart(4, '0')}F1ZV` : null,
      phone: `98${String(10_000_000 + i)}`,
      city: ['Pune', 'Mumbai', 'Chennai'][i % 3],
    }));
    for (let i = 0; i < rows.length; i += 100)
      await d.db.insert(d.schema.parties).values(rows.slice(i, i + 100));
    const repo = new PartyRepo(d);
    await repo.search(ctx, 'sharma'); // warm up
    const times: number[] = [];
    for (const q of ['sharma', 'iyer traders', 'pune', '9810', '27AAPFU1007F1ZV', 'patel s']) {
      const t0 = performance.now();
      const found = await repo.search(ctx, q, 20);
      times.push(performance.now() - t0);
      expect(found.length, q).toBeGreaterThan(0);
    }
    expect(Math.max(...times)).toBeLessThan(100);
    await runInTx(d, ctx, async () => {});
  }, 60_000);

  it('builds an account for a party with 200 documents in under 100 ms', async () => {
    const d = await openTestDb('sqlite');
    opened.push(d);
    const { ctx } = await seedDemo(d, { documents: 20, parties: 5, items: 10, heavyParty: 200 });
    const parties = await new PartyRepo(d).search(ctx, 'heavy');
    expect(parties).toHaveLength(1);
    const t0 = performance.now();
    const acc = await getPartyAccount(d, ctx, parties[0]!['id'], '2026-06-30');
    const ms = performance.now() - t0;
    expect(acc.documentCount).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(100);
  }, 60_000);
});
