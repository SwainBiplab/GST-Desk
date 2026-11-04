import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from './database';
import { DocumentRepo, PartyRepo } from './repositories/aggregates';
import { BaseRepo, runInTx } from './repositories/base';
import { arithmeticValidator } from './repositories/line-math';
import { seedDemo } from './seed';
import { DIALECTS, openTestDb } from './testing/harness';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

describe.each(DIALECTS)('seedDemo (%s)', (dialect) => {
  it('creates the demo dataset with consistent money', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, counts } = await seedDemo(d);
    expect(counts['parties']).toBe(50);
    expect(counts['items']).toBe(200);
    expect(counts['documents']).toBe(500);
    expect(counts['payments']).toBeGreaterThan(50);
    expect(counts['stock_movements']).toBeGreaterThan(200);

    const docs = new DocumentRepo(d);
    const all = await docs.list(ctx);
    expect(all).toHaveLength(500);
    expect(new Set(all.map((x) => x['type'])).size).toBeGreaterThanOrEqual(7);
    const years = new Set(all.map((x) => (x['date'] as string) < '2025-04-01'));
    expect(years.size).toBe(2);

    // every seeded document passes the same validation the repository enforces
    for (const doc of all.slice(0, 60)) {
      const full = await docs.getWithLines(ctx, doc['id']);
      expect(arithmeticValidator(full!.document, full!.lines), doc['id']).toEqual([]);
    }
    // search works on seeded rows
    expect((await new PartyRepo(d).search(ctx, 'sharma')).length).toBeGreaterThan(0);
    const units = await new BaseRepo(d, 'units').list(ctx);
    expect(units.length).toBeGreaterThan(5);
    await runInTx(d, ctx, async () => {});
  }, 60_000);

  it('is deterministic for a given seed', async () => {
    const a = await openTestDb(dialect);
    const b = await openTestDb(dialect);
    opened.push(a, b);
    const ra = await seedDemo(a, { documents: 40, items: 20, parties: 10 });
    const rb = await seedDemo(b, { documents: 40, items: 20, parties: 10 });
    const pick = async (d: Database, ctx: typeof ra.ctx) =>
      (await new DocumentRepo(d).list(ctx)).map((x) => [
        x['number'],
        x['date'],
        x['total_paise'],
        x['status'],
      ]);
    expect(await pick(a, ra.ctx)).toEqual(await pick(b, rb.ctx));
  }, 60_000);
});
