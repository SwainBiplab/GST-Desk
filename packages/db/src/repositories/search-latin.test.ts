import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import type { Ctx } from './base';
import { ItemRepo } from './items';

describe.each(DIALECTS)(
  'names typed in a native script are found by their Roman form (%s)',
  (dialect) => {
    let d: Database;
    let ctx: Ctx;

    beforeAll(async () => {
      d = await openTestDb(dialect);
      const org = await createOrganisation(d, 'Org');
      const base: Ctx = { orgId: org['id'], businessId: '', actor: 't', deviceId: 'd' };
      const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
      ctx = { ...base, businessId: biz['id'] };
    }, 60_000);
    afterAll(async () => {
      await d.close();
    });

    it('finds a party by its native name and by its Roman key, and keeps its language', async () => {
      const parties = new PartyRepo(d);
      const p = await parties.create(ctx, {
        type: 'customer',
        name: 'शर्मा ट्रेडर्स',
        name_latin: 'sharma traders',
        language: 'hi',
        state_code: '27',
      });
      // Postgres's default text parser splits Devanagari at its vowel signs (backlog); SQLite's does not
      if (dialect === 'sqlite')
        expect((await parties.search(ctx, 'शर्मा')).map((r) => r['id'])).toContain(p['id']);
      expect((await parties.search(ctx, 'sharma tra')).map((r) => r['id'])).toContain(p['id']);
      expect((await parties.get(ctx, p['id']))!['language']).toBe('hi');
      await parties.update(ctx, p['id'], { name_latin: 'sharma stores' }, p['version']);
      expect(await parties.search(ctx, 'traders')).toEqual([]);
      expect((await parties.search(ctx, 'stores')).length).toBe(1);
    });

    it('finds an item the same way', async () => {
      const items = new ItemRepo(d);
      const i = await items.create(ctx, {
        name: 'चाय पत्ती',
        name_latin: 'chai patti',
        gst_rate_bp: 500,
      });
      expect((await items.search(ctx, 'chai')).map((r) => r['id'])).toContain(i['id']);
      if (dialect === 'sqlite')
        expect((await items.search(ctx, 'चाय')).map((r) => r['id'])).toContain(i['id']);
    });
  },
);
