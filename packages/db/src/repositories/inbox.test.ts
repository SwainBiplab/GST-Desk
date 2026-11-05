import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, ReviewRepo, createOrganisation } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { ItemRepo } from './items';
import { getCounts } from './stats';

async function tenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

describe.each(DIALECTS)('review inbox storage (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let reviews: ReviewRepo;

  const raise = (kind: string, key: string, over: Record<string, unknown> = {}) =>
    reviews.create(ctx, {
      kind,
      payload_json: {},
      suggestion_json: {},
      source: 'rules',
      status: 'pending',
      dedupe_key: key,
      ...over,
    });

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    reviews = new ReviewRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('splits waiting, snoozed and finished items, and a snooze ends by itself', async () => {
    const now = 1_000_000;
    const open = await raise('low_stock', 'low_stock:a');
    const snoozed = await raise('low_stock', 'low_stock:b');
    const done = await raise('draft_stale', 'draft_stale:c');
    await reviews.snooze(ctx, snoozed['id'], now + 60_000, snoozed['version']);
    await reviews.reject(ctx, done['id'], done['version'], '  not needed  ');

    const ids = async (view: 'open' | 'snoozed' | 'done') =>
      (await reviews.inbox(ctx, { view, now })).map((r) => r['id']);
    expect(await ids('open')).toContain(open['id']);
    expect(await ids('open')).not.toContain(snoozed['id']);
    expect(await ids('snoozed')).toEqual([snoozed['id']]);
    expect(await ids('done')).toEqual([done['id']]);
    // after the time passes it is open again
    const later = (await reviews.inbox(ctx, { view: 'open', now: now + 120_000 })).map(
      (r) => r['id'],
    );
    expect(later).toContain(snoozed['id']);

    const rejected = await reviews.get(ctx, done['id']);
    expect(rejected?.['reject_reason']).toBe('not needed');
    expect(rejected?.['status']).toBe('rejected');
  });

  it('filters by kind', async () => {
    const rows = await reviews.inbox(ctx, { view: 'open', kinds: ['draft_stale'] });
    expect(rows.every((r) => r['kind'] === 'draft_stale')).toBe(true);
  });

  it('remembers everything ever raised by its key, whatever became of it', async () => {
    const seen = await reviews.seen(ctx, ['low_stock', 'draft_stale']);
    expect(seen.get('low_stock:a')?.status).toBe('pending');
    expect(seen.get('draft_stale:c')?.status).toBe('rejected');
    expect(await reviews.seen(ctx, [])).toEqual(new Map());
  });

  it('closes findings that stopped being true, and only pending ones', async () => {
    const x = await raise('hsn_suggestion', 'hsn_suggestion:x');
    const y = await raise('hsn_suggestion', 'hsn_suggestion:y');
    await reviews.accept(ctx, y['id'], y['version'], { code: '1234' });
    const n = await reviews.expire(ctx, [x['id'], y['id']]);
    expect(n).toBe(1);
    expect((await reviews.get(ctx, x['id']))?.['status']).toBe('expired');
    const accepted = await reviews.get(ctx, y['id']);
    expect(accepted?.['status']).toBe('accepted');
    expect(accepted?.['correction_json']).toEqual({ code: '1234' });
  });

  it('does not count snoozed items in the badge', async () => {
    const before = (await getCounts(d, ctx)).reviewPending;
    const r = await raise('reminder_due', 'reminder_due:p:2026-W01');
    expect((await getCounts(d, ctx)).reviewPending).toBe(before + 1);
    await reviews.snooze(ctx, r['id'], Date.now() + 3_600_000, r['version']);
    expect((await getCounts(d, ctx)).reviewPending).toBe(before);
    await reviews.unsnooze(ctx, r['id'], (await reviews.get(ctx, r['id']))!['version']);
    expect((await getCounts(d, ctx)).reviewPending).toBe(before + 1);
  });
});

describe.each(DIALECTS)('merging items (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let items: ItemRepo;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    items = new ItemRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('moves stock and files to the kept item, fills its gaps, archives the other and audits it', async () => {
    const keep = await items.create(ctx, {
      name: 'Bolt 10mm',
      gst_rate_bp: 1800,
      track_stock: true,
      opening_stock_micros: 5_000_000,
      min_stock_micros: 2_000_000,
    });
    const gone = await items.create(ctx, {
      name: 'Bolt 10 mm',
      hsn: '7318',
      sku: 'BOLT10',
      barcode: '8901234',
      gst_rate_bp: 1800,
      sale_rate_paise: 1500,
      track_stock: true,
      opening_stock_micros: 3_000_000,
      min_stock_micros: 4_000_000,
    });

    const record = await items.merge(ctx, gone['id'], keep['id']);
    expect(record.moved.stock_movements.length).toBe(1);

    const kept = (await items.get(ctx, keep['id']))!;
    expect(kept['hsn']).toBe('7318');
    expect(kept['sku']).toBe('BOLT10');
    expect(kept['barcode']).toBe('8901234');
    expect(Number(kept['sale_rate_paise'])).toBe(1500);
    expect(Number(kept['min_stock_micros'])).toBe(4_000_000);

    expect(await items.get(ctx, gone['id'])).toBeNull();

    const movements = (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
      (m) => m['item_id'] === keep['id'],
    );
    expect(movements.reduce((s, m) => s + Number(m['qty_micros']), 0)).toBe(8_000_000);

    const trail = await new AuditRepo(d).forRow(
      ctx,
      'stock_movements',
      record.moved.stock_movements[0]!,
    );
    expect(trail.some((a) => a['action'] === 'update')).toBe(true);
  });

  it('will not merge an item into itself or a product with a service', async () => {
    const p = await items.create(ctx, { name: 'Pipe', gst_rate_bp: 1800, kind: 'product' });
    const s = await items.create(ctx, { name: 'Fitting work', gst_rate_bp: 1800, kind: 'service' });
    await expect(items.merge(ctx, p['id'], p['id'])).rejects.toThrow();
    await expect(items.merge(ctx, p['id'], s['id'])).rejects.toThrow();
    expect(await items.get(ctx, p['id'])).not.toBeNull();
  });
});
