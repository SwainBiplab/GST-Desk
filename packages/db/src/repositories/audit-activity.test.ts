import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import type { Ctx } from './base';

describe.each(DIALECTS)('who has been changing the books (%s)', (dialect) => {
  let d: Database;
  let asha: Ctx;
  let bala: Ctx;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    const org = await createOrganisation(d, 'Org');
    const base: Ctx = { orgId: org['id'], businessId: '', actor: 'asha', deviceId: 'a' };
    const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
    asha = { ...base, businessId: biz['id'] };
    bala = { ...asha, actor: 'bala', deviceId: 'b' };
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('counts each person’s changes with their first and last, and filters by date', async () => {
    const parties = new PartyRepo(d);
    const before = Date.now();
    await parties.create(asha, { type: 'customer', name: 'One', state_code: '27' });
    await parties.create(bala, { type: 'customer', name: 'Two', state_code: '27' });
    await parties.create(bala, { type: 'customer', name: 'Three', state_code: '27' });
    const people = await new AuditRepo(d).activity(asha);
    const byActor = Object.fromEntries(people.map((p) => [p.actor, p]));
    expect(byActor['bala']?.changes).toBe(2);
    // the business itself was made by asha, so she has that change too
    expect(byActor['asha']?.changes).toBeGreaterThanOrEqual(2);
    expect(byActor['bala']!.lastAt).toBeGreaterThanOrEqual(byActor['bala']!.firstAt);
    expect(people[0]?.actor).toBe('bala');
    // before the parties, only the business asha made
    const earlier = await new AuditRepo(d).activity(asha, { to: before - 1 });
    expect(earlier.map((p) => [p.actor, p.changes])).toEqual([['asha', 1]]);
  });
});
