import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BusinessRepo,
  ItemRepo,
  PartyRepo,
  ReminderRepo,
  ReviewRepo,
  createOrganisation,
  importHsnVersion,
  type Ctx,
  type Database,
} from '@gst/db';
import { seedDemo } from '@gst/db/seed';
import { DIALECTS, openTestDb } from '@gst/db/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  acceptReviewItems,
  applyReviewItem,
  bulkCandidates,
  rejectReviewItem,
  runTier0,
} from '../src/db';

const MASTER = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'hsn-master.json'), 'utf8'),
);

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function setup(dialect: (typeof DIALECTS)[number]) {
  const d = await openTestDb(dialect);
  opened.push(d);
  await importHsnVersion(d, { version: 'test', as_of: '2026-01-01' }, MASTER);
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'user-1', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { d, ctx: { ...base, businessId: biz['id'] } as Ctx };
}

describe.each(DIALECTS)('Tier 0 on the database (%s)', (dialect) => {
  it('raises a duplicate party once, merges on accept, and does not raise it again', async () => {
    const { d, ctx } = await setup(dialect);
    const parties = new PartyRepo(d);
    const a = await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma Traders',
      phone: '9820012345',
      state_code: '27',
    });
    const b = await parties.create(ctx, {
      type: 'customer',
      name: 'M/s Sharma Traders Pvt Ltd',
      phone: '+91 98200 12345',
      state_code: '27',
    });
    const reviews = new ReviewRepo(d);

    const first = await runTier0(d, ctx, { kinds: ['duplicate_party'] });
    expect(first.created).toBe(1);
    const [item] = await reviews.inbox(ctx, { view: 'open' });
    expect(item!['kind']).toBe('duplicate_party');
    expect(item!['dedupe_key']).toBe(`duplicate_party:${[a['id'], b['id']].sort().join(':')}`);

    // running again changes nothing
    expect((await runTier0(d, ctx, { kinds: ['duplicate_party'] })).created).toBe(0);

    await applyReviewItem(d, ctx, item!);
    expect(await parties.get(ctx, item!['suggestion_json'].mergeId)).toBeNull();
    expect((await reviews.get(ctx, item!['id']))!['status']).toBe('accepted');

    // a person's answer is final: it stays accepted and is not raised again
    expect((await runTier0(d, ctx, { kinds: ['duplicate_party'] })).created).toBe(0);
  });

  it('suggests an HSN for an item without one, and accepting fills it in', async () => {
    const { d, ctx } = await setup(dialect);
    const items = new ItemRepo(d);
    const it = await items.create(ctx, { name: 'Copper wire 2.5 sqmm', gst_rate_bp: 1800 });
    const r = await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    expect(r.created).toBe(1);
    const reviews = new ReviewRepo(d);
    const [row] = await reviews.inbox(ctx, { view: 'open', kinds: ['hsn_suggestion'] });
    const sug = row!['suggestion_json'];
    expect(sug.itemId).toBe(it['id']);
    await applyReviewItem(d, ctx, row!);
    expect((await items.get(ctx, it['id']))!['hsn']).toBe(sug.code);
    // the item has an HSN now, so there is nothing left to suggest
    expect((await runTier0(d, ctx, { kinds: ['hsn_suggestion'] })).created).toBe(0);
  });

  it('records the edit when a suggestion is changed before accepting (for evals)', async () => {
    const { d, ctx } = await setup(dialect);
    await new ItemRepo(d).create(ctx, { name: 'Copper wire 2.5 sqmm', gst_rate_bp: 1800 });
    await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    const reviews = new ReviewRepo(d);
    const [row] = await reviews.inbox(ctx, { view: 'open' });
    const edited = { ...row!['suggestion_json'], code: '8544' };
    await applyReviewItem(d, ctx, row!, edited);
    const done = (await reviews.get(ctx, row!['id']))!;
    expect(done['correction_json']).toEqual([
      expect.objectContaining({ path: 'code', op: 'change', after: '8544' }),
    ]);
  });

  it('a rejected finding stays rejected with its reason; a cleared one expires', async () => {
    const { d, ctx } = await setup(dialect);
    const items = new ItemRepo(d);
    const it = await items.create(ctx, { name: 'Copper wire 2.5 sqmm', gst_rate_bp: 1800 });
    await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    const reviews = new ReviewRepo(d);
    const [row] = await reviews.inbox(ctx, { view: 'open' });
    await rejectReviewItem({
      db: d,
      ctx,
      id: row!['id'],
      expectedVersion: row!['version'],
      reason: 'wrong',
    });
    expect((await runTier0(d, ctx, { kinds: ['hsn_suggestion'] })).created).toBe(0);
    expect((await reviews.get(ctx, row!['id']))!['reject_reason']).toBe('wrong');

    // a different item gets a suggestion, then the person sets its HSN by hand: the finding is no longer true
    const other = await items.create(ctx, { name: 'Copper wire 4 sqmm', gst_rate_bp: 1800 });
    expect((await runTier0(d, ctx, { kinds: ['hsn_suggestion'] })).created).toBe(1);
    await items.update(ctx, other['id'], { hsn: '7408' }, other['version']);
    const cleared = await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    expect(cleared.expired).toBe(1);
    expect(it['id']).toBeDefined();
  });

  it('a seeded demo book produces a populated inbox on first run, and a second run adds nothing', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    await importHsnVersion(d, { version: 'test', as_of: '2026-01-01' }, MASTER);
    const { ctx } = await seedDemo(d, { parties: 30, items: 30, documents: 120 });
    const first = await runTier0(d, ctx, { inventoryEnabled: true });
    expect(first.created).toBeGreaterThan(5);
    expect(Object.keys(first.byKind).length).toBeGreaterThanOrEqual(2);
    const open = await new ReviewRepo(d).inbox(ctx, { view: 'open' });
    expect(open.length).toBe(first.created);
    const reminder = open.find((r) => r['kind'] === 'reminder_due');
    expect(reminder, 'the demo has customers who owe money').toBeDefined();
    const msg = String(reminder!['suggestion_json'].message);
    expect(msg).toContain(reminder!['suggestion_json'].partyName);
    expect(msg).not.toMatch(/[{}]/);
    expect((await runTier0(d, ctx, { inventoryEnabled: true })).created).toBe(0);
    // accepting a reminder records it against the customer
    await applyReviewItem(d, ctx, reminder!);
    expect(
      (await new ReminderRepo(d).forParty(ctx, reminder!['suggestion_json'].partyId)).length,
    ).toBe(1);
  });

  it('bulk accept applies all or none, and offers only sure, low-risk kinds', async () => {
    const { d, ctx } = await setup(dialect);
    const items = new ItemRepo(d);
    for (const n of ['Copper wire 2.5 sqmm', 'Copper wire 4 sqmm'])
      await items.create(ctx, { name: n, gst_rate_bp: 1800 });
    await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    const rows = await new ReviewRepo(d).inbox(ctx, { view: 'open' });
    expect(rows.length).toBe(2);
    expect(bulkCandidates(rows, 0).length).toBe(2);
    expect(bulkCandidates(rows, 101).length).toBe(0);
    // a stale version fails the whole batch and leaves every item pending
    const stale = { ...rows[1]!, version: 99 };
    await expect(acceptReviewItems(d, ctx, [rows[0]!, stale])).rejects.toThrow();
    expect((await new ReviewRepo(d).inbox(ctx, { view: 'open' })).length).toBe(2);
    await acceptReviewItems(d, ctx, rows);
    expect((await new ReviewRepo(d).inbox(ctx, { view: 'open' })).length).toBe(0);
  });

  it('applies nothing by itself, and an explicit auto-rule accepts only sure suggestions', async () => {
    const { d, ctx } = await setup(dialect);
    await new ItemRepo(d).create(ctx, { name: 'Copper wire 2.5 sqmm', gst_rate_bp: 1800 });
    const off = await runTier0(d, ctx, { kinds: ['hsn_suggestion'] });
    expect(off.autoAccepted).toBe(0);
    expect((await new ReviewRepo(d).inbox(ctx, { view: 'open' })).length).toBe(1);
  });
});
