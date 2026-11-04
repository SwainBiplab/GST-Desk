import {
  BusinessRepo,
  PartyRepo,
  ReviewRepo,
  RuleError,
  createOrganisation,
  runInTx,
  type Ctx,
  type Database,
} from '@gst/db';
import { DIALECTS, openTestDb } from '@gst/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { jsonDiff } from '../src';
import { ReviewError, acceptReviewItem, createReviewItem, rejectReviewItem } from '../src/db';

const schema = z.object({ hsn: z.string(), rateBp: z.number().int() });

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function setup(dialect: (typeof DIALECTS)[number]) {
  const d = await openTestDb(dialect);
  opened.push(d);
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'user-1', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { d, ctx: { ...base, businessId: biz['id'] } as Ctx };
}

describe('jsonDiff', () => {
  it('reports add, remove and change with paths', () => {
    expect(
      jsonDiff({ a: 1, b: { c: 2 }, d: [1, 2] }, { a: 1, b: { c: 3 }, d: [1], e: 'x' }),
    ).toEqual([
      { path: 'b.c', op: 'change', before: 2, after: 3 },
      { path: 'd.1', op: 'remove', before: 2 },
      { path: 'e', op: 'add', after: 'x' },
    ]);
    expect(jsonDiff([1], [1, 2])).toEqual([{ path: '1', op: 'add', after: 2 }]);
    expect(jsonDiff(null, { a: 1 })).toEqual([
      { path: '', op: 'change', before: null, after: { a: 1 } },
    ]);
    expect(jsonDiff({ a: [] }, { a: [] })).toEqual([]);
    expect(jsonDiff({ a: 1 }, 5)).toEqual([{ path: '', op: 'change', before: { a: 1 }, after: 5 }]);
  });
});

describe.each(DIALECTS)('review items (%s)', (dialect) => {
  it('creates a pending item with a computed diff', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'hsn_suggestion',
      payload: { hsn: '', rateBp: 0 },
      suggestion: { hsn: '7408', rateBp: 1800 },
      schema,
      source: 'rules',
      model: 'rules:hsn_lookup',
      confidence: 0.84,
    });
    expect(item['status']).toBe('pending');
    expect(item['confidence']).toBe(84);
    expect(item['diff_json']).toEqual([
      { path: 'hsn', op: 'change', before: '', after: '7408' },
      { path: 'rateBp', op: 'change', before: 0, after: 1800 },
    ]);
    expect(await new ReviewRepo(d).pending(ctx)).toHaveLength(1);
  }, 60_000);

  it('rejects a suggestion that does not match its schema', async () => {
    const { d, ctx } = await setup(dialect);
    await expect(
      createReviewItem({
        db: d,
        ctx,
        kind: 'x',
        payload: null,
        suggestion: { hsn: 5 } as never,
        schema,
        source: 'rules',
      }),
    ).rejects.toBeInstanceOf(ReviewError);
  }, 60_000);

  it('applies an accepted suggestion once, in the same transaction', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'k',
      payload: {},
      suggestion: { hsn: '7408', rateBp: 1800 },
      schema,
      source: 'rules',
    });
    const applied: unknown[] = [];
    const accepted = await acceptReviewItem({
      db: d,
      ctx,
      id: item['id'],
      expectedVersion: item['version'],
      schema,
      apply: async (v, c) => {
        applied.push(v);
        await new PartyRepo(d).create(c, { type: 'customer', name: `HSN ${v.hsn}` });
      },
    });
    expect(applied).toEqual([{ hsn: '7408', rateBp: 1800 }]);
    expect(accepted['status']).toBe('accepted');
    expect(accepted['accepted_by']).toBe('user-1');
    expect(accepted['correction_json']).toBeNull();
    expect((await new PartyRepo(d).list(ctx)).map((p) => p['name'])).toEqual(['HSN 7408']);
    await expect(
      acceptReviewItem({
        db: d,
        ctx,
        id: item['id'],
        expectedVersion: accepted['version'],
        schema,
        apply: async () => {},
      }),
    ).rejects.toBeInstanceOf(RuleError);
  }, 60_000);

  it('applies the user edit and records it as a correction', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'k',
      payload: {},
      suggestion: { hsn: '7408', rateBp: 1800 },
      schema,
      source: 'rules',
    });
    const applied: unknown[] = [];
    const accepted = await acceptReviewItem({
      db: d,
      ctx,
      id: item['id'],
      expectedVersion: item['version'],
      schema,
      edited: { hsn: '8544', rateBp: 1800 },
      apply: async (v) => void applied.push(v),
    });
    expect(applied).toEqual([{ hsn: '8544', rateBp: 1800 }]);
    expect(accepted['correction_json']).toEqual([
      { path: 'hsn', op: 'change', before: '7408', after: '8544' },
    ]);
  }, 60_000);

  it('rejects an invalid edit and rolls back when apply throws', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'k',
      payload: {},
      suggestion: { hsn: '7408', rateBp: 1800 },
      schema,
      source: 'rules',
    });
    await expect(
      acceptReviewItem({
        db: d,
        ctx,
        id: item['id'],
        expectedVersion: 1,
        schema,
        edited: { hsn: 7 },
        apply: async () => {},
      }),
    ).rejects.toBeInstanceOf(ReviewError);
    await expect(
      acceptReviewItem({
        db: d,
        ctx,
        id: item['id'],
        expectedVersion: 1,
        schema,
        apply: async (_v, c) => {
          await new PartyRepo(d).create(c, { type: 'customer', name: 'Half applied' });
          throw new Error('apply failed');
        },
      }),
    ).rejects.toThrow('apply failed');
    expect(await new PartyRepo(d).list(ctx)).toEqual([]);
    expect((await new ReviewRepo(d).get(ctx, item['id']))?.['status']).toBe('pending');
  }, 60_000);

  it('rejects items and refuses to accept unknown ones', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'k',
      payload: {},
      suggestion: { hsn: '1', rateBp: 0 },
      schema,
      source: 'rules',
    });
    const rejected = await rejectReviewItem({ db: d, ctx, id: item['id'], expectedVersion: 1 });
    expect(rejected['status']).toBe('rejected');
    expect(await new ReviewRepo(d).pending(ctx)).toEqual([]);
    await expect(
      acceptReviewItem({
        db: d,
        ctx,
        id: crypto.randomUUID(),
        expectedVersion: 1,
        schema,
        apply: async () => {},
      }),
    ).rejects.toBeInstanceOf(ReviewError);
  }, 60_000);

  it('does not let an AI actor accept or reject', async () => {
    const { d, ctx } = await setup(dialect);
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'k',
      payload: {},
      suggestion: { hsn: '1', rateBp: 0 },
      schema,
      source: 'rules',
    });
    const bot: Ctx = { ...ctx, actor: 'ai:anthropic' };
    await expect(
      acceptReviewItem({
        db: d,
        ctx: bot,
        id: item['id'],
        expectedVersion: 1,
        schema,
        apply: async () => {},
      }),
    ).rejects.toBeInstanceOf(RuleError);
    await expect(
      rejectReviewItem({ db: d, ctx: bot, id: item['id'], expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(RuleError);
    expect(
      (await runInTx(d, ctx, (tx) => new ReviewRepo(d).get({ ...ctx, tx }, item['id'])))?.[
        'status'
      ],
    ).toBe('pending');
  }, 60_000);
});
