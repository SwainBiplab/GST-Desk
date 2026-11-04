import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from './database';
import { announce, onChange } from './events';
import {
  BusinessRepo,
  DocumentRepo,
  PartyRepo,
  PaymentRepo,
  createOrganisation,
} from './repositories/aggregates';
import { runInTx, type Ctx } from './repositories/base';
import { computeLine } from './repositories/line-math';
import { getCounts, getRecent, getTodaySummary } from './repositories/stats';
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

describe.each(DIALECTS)('change events (%s)', (dialect) => {
  it('announces written tables after commit and nothing after a rollback', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    const seen: string[][] = [];
    const off = onChange(d, (t) => seen.push([...t].sort()));
    const parties = new PartyRepo(d);

    await parties.create(ctx, { type: 'customer', name: 'A' });
    expect(seen).toEqual([['parties']]);

    seen.length = 0;
    await expect(
      runInTx(d, ctx, async (tx) => {
        await parties.create({ ...ctx, tx }, { type: 'customer', name: 'B' });
        expect(seen).toEqual([]); // not before commit
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([]);

    // one announcement per transaction, covering every table touched
    await runInTx(d, ctx, async (tx) => {
      await parties.create({ ...ctx, tx }, { type: 'supplier', name: 'C' });
      await new PaymentRepo(d).record(
        { ...ctx, tx },
        { date: '2026-01-01', mode: 'cash', amount_paise: 100 },
      );
    });
    expect(seen).toEqual([['parties', 'payments']]);

    off();
    seen.length = 0;
    await parties.create(ctx, { type: 'customer', name: 'D' });
    expect(seen).toEqual([]);
    announce(d, ['x']); // no listeners: must not throw
  }, 60_000);

  it('survives a throwing listener', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    onChange(d, () => {
      throw new Error('listener bug');
    });
    await expect(
      new PartyRepo(d).create(ctx, { type: 'customer', name: 'A' }),
    ).resolves.toBeDefined();
  }, 60_000);
});

describe.each(DIALECTS)('stats (%s)', (dialect) => {
  it('counts rows and ignores soft-deleted ones', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx } = await seedDemo(d, { documents: 60, parties: 10, items: 20 });
    const counts = await getCounts(d, ctx);
    expect(counts).toMatchObject({ parties: 10, items: 20, documents: 60, reviewPending: 0 });
    expect(counts.payments).toBeGreaterThan(0);

    const p = (await new PartyRepo(d).list(ctx, { limit: 1 }))[0]!;
    // a party with documents cannot be deleted, so create a fresh one to delete
    const extra = await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Gone' });
    expect((await getCounts(d, ctx)).parties).toBe(11);
    await new PartyRepo(d).softDelete(ctx, extra['id'], 1);
    expect((await getCounts(d, ctx)).parties).toBe(10);
    expect(p).toBeDefined();
  }, 60_000);

  it('summarises today: sales, cash received and pending', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    const docs = new DocumentRepo(d);
    const line = {
      qty_micros: 1_000_000,
      rate_paise: 100_000,
      discount_mode: 'none',
      discount_value: 0,
      cgst_bp: 900,
      sgst_bp: 900,
    };
    const calc = computeLine(line);
    const doc = (date: string) => ({
      type: 'tax_invoice',
      date,
      total_taxable_paise: calc.taxable_paise,
      total_cgst_paise: calc.cgst_paise,
      total_sgst_paise: calc.sgst_paise,
      total_paise: calc.total_paise,
    });
    const make = async (date: string, number: string) => {
      const c = await docs.createWithLines(ctx, doc(date), [{ ...line, ...calc }]);
      return docs.issue(ctx, c.document['id'], 1, number);
    };
    const today = await make('2026-05-01', 'T1');
    await make('2026-04-30', 'Y1');
    await new PaymentRepo(d).record(
      ctx,
      { date: '2026-05-01', mode: 'cash', amount_paise: 50_000 },
      [{ document_id: today['id'], amount_paise: 50_000 }],
    );
    await new PaymentRepo(d).record(ctx, { date: '2026-05-01', mode: 'upi', amount_paise: 1_000 });

    const s = await getTodaySummary(d, ctx, '2026-05-01');
    expect(s).toEqual({
      salesPaise: 118_000,
      cashReceivedPaise: 50_000,
      pendingPaise: 2 * 118_000 - 50_000,
    });
    expect(await getTodaySummary(d, ctx, '2030-01-01')).toMatchObject({
      salesPaise: 0,
      cashReceivedPaise: 0,
    });
  }, 60_000);

  it('lists recently touched rows across aggregates', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const ctx = await tenant(d);
    await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Sharma' });
    const recent = await getRecent(d, ctx, 5);
    expect(recent[0]).toMatchObject({ kind: 'party', title: 'Sharma' });
    expect(await getRecent(d, { ...ctx, businessId: crypto.randomUUID() })).toEqual([]);
  }, 60_000);
});
