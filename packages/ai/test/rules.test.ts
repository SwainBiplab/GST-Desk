import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BusinessRepo,
  PartyRepo,
  createOrganisation,
  insertHsnEntries,
  type Ctx,
  type Database,
} from '@gst/db';
import { DIALECTS, openTestDb } from '@gst/db/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  AiRouter,
  InMemoryHsnLookup,
  RulesProvider,
  duplicatePartySchema,
  findDuplicateParties,
  hsnSuggestionsSchema,
  normaliseName,
  normalisePhone,
  similarity,
  tokenize,
  type HsnLookup,
} from '../src';
import { DbCallLogger, DbHsnLookup, createDbRulesEnv } from '../src/db';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const master = JSON.parse(readFileSync(join(fixtures, 'hsn-master.json'), 'utf8')) as {
  code: string;
  description: string;
  rate_bp: number;
  effective_from: string;
}[];
const queries = JSON.parse(readFileSync(join(fixtures, 'hsn-queries.json'), 'utf8')) as {
  description: string;
  expectedCode: string;
}[];

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

function top3(lookup: HsnLookup) {
  return async (q: string) => (await lookup.search(q, 3)).map((h) => h.code);
}

describe('HSN suggestions: top 3 for 20 sample descriptions', () => {
  it('has 20 queries', () => expect(queries).toHaveLength(20));

  it('in-memory BM25', async () => {
    const lookup = top3(new InMemoryHsnLookup(master));
    const misses: string[] = [];
    for (const q of queries) {
      if (!(await lookup(q.description)).includes(q.expectedCode)) misses.push(q.description);
    }
    expect(misses).toEqual([]);
  });

  describe.each(DIALECTS)('database (%s)', (dialect) => {
    it('FTS ranking', async () => {
      const d = await openTestDb(dialect);
      opened.push(d);
      await insertHsnEntries(d, master);
      const lookup = top3(new DbHsnLookup(d));
      const misses: string[] = [];
      for (const q of queries) {
        if (!(await lookup(q.description)).includes(q.expectedCode)) misses.push(q.description);
      }
      expect(misses).toEqual([]);
      const first = await new DbHsnLookup(d).search('copper wire', 3);
      expect(first[0]).toMatchObject({ code: '7408', rateBp: 1800, cessBp: 0 });
    }, 60_000);
  });

  it('tokenizes with light stemming and stop words', () => {
    expect(tokenize('Copper wires of the other kind')).toEqual(['copper', 'wire', 'kind']);
  });
});

describe('RulesProvider', () => {
  it('answers HSN lookups through the router, offline, with confidence', async () => {
    const router = new AiRouter({
      settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
      providers: [new RulesProvider({ hsn: new InMemoryHsnLookup(master) })],
    });
    const r = await router.suggest(
      { feature: 'hsn_lookup', input: { description: 'steel pipes', limit: 3 } },
      hsnSuggestionsSchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe('rules');
      expect(r.value.suggestions[0]?.code).toBe('7306');
      expect(r.confidence).toBeGreaterThan(0.2);
      expect(r.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it('reports low confidence for no match and rule_failed without a source', async () => {
    const rules = new RulesProvider({ hsn: new InMemoryHsnLookup(master) });
    const none = await rules.suggest(
      { feature: 'hsn_lookup', input: { description: 'qwertyuiop' } },
      hsnSuggestionsSchema,
    );
    expect(none.ok && none.confidence).toBe(0.2);
    const bare = new RulesProvider();
    const r = await bare.suggest(
      { feature: 'hsn_lookup', input: { description: 'x' } },
      hsnSuggestionsSchema,
    );
    expect(!r.ok && r.error.code).toBe('rule_failed');
    const d = await bare.suggest(
      { feature: 'duplicate_party', input: { name: 'x' } },
      duplicatePartySchema,
    );
    expect(!d.ok && d.error.code).toBe('rule_failed');
  });

  it('refuses output that fails the caller schema', async () => {
    const rules = new RulesProvider({ hsn: new InMemoryHsnLookup(master) });
    const { z } = await import('zod');
    const r = await rules.suggest(
      { feature: 'hsn_lookup', input: { description: 'copper' } },
      z.object({ other: z.string() }),
    );
    expect(!r.ok && r.error.code).toBe('invalid_output');
  });

  it('lets later prompts register rules', async () => {
    const rules = new RulesProvider().registerRule('echo', async (input) => ({
      value: { said: input.say },
      confidence: 1,
    }));
    const { z } = await import('zod');
    expect(rules.hasRule('echo')).toBe(true);
    const r = await rules.suggest(
      { feature: 'echo', input: { say: 'hi' } },
      z.object({ said: z.string() }),
    );
    expect(r.ok && r.value.said).toBe('hi');
    const unknown = await rules.suggest({ feature: 'nope' }, z.object({}));
    expect(!unknown.ok && unknown.error.code).toBe('unsupported');
  });

  it('declares only the suggest capability', () => {
    expect([...new RulesProvider().capabilities()]).toEqual(['suggest']);
  });
});

describe('duplicate party detection', () => {
  const existing = [
    {
      id: '1',
      name: 'Sharma Traders Pvt. Ltd.',
      gstin: '27AAPFU0939F1ZV',
      phone: '+91 98765 43210',
    },
    { id: '2', name: 'Iyer & Sons', gstin: null, phone: '9123456789' },
    { id: '3', name: 'Totally Different Co', gstin: '29AABCT1332L1ZG', phone: null },
  ];

  it('normalises names and phones', () => {
    expect(normaliseName('M/s. Sharma & Sons Pvt. Ltd.')).toBe('sharma sons');
    expect(normaliseName('The Iyer Company LLP')).toBe('iyer');
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });

  it('matches by GSTIN regardless of name', () => {
    const m = findDuplicateParties(
      { name: 'Completely New Name', gstin: '27aapfu0939f1zv' },
      existing,
    );
    expect(m).toEqual([
      { id: '1', name: 'Sharma Traders Pvt. Ltd.', score: 1, reasons: ['gstin'] },
    ]);
  });

  it('matches by normalised name and by phone plus similar name', () => {
    const byName = findDuplicateParties({ name: 'SHARMA TRADERS' }, existing);
    expect(byName[0]).toMatchObject({ id: '1', reasons: ['name'], score: 0.85 });
    const byPhone = findDuplicateParties({ name: 'Iyer and Sons', phone: '91234 56789' }, existing);
    expect(byPhone[0]).toMatchObject({ id: '2', score: 0.9 });
    expect(byPhone[0]?.reasons).toEqual(expect.arrayContaining(['phone', 'name']));
    const phoneOnly = findDuplicateParties({ name: 'Zzz', phone: '9123456789' }, existing, {
      minScore: 0.5,
    });
    expect(phoneOnly[0]).toMatchObject({ id: '2', score: 0.6, reasons: ['phone'] });
  });

  it('catches near-miss spellings and ignores unrelated parties', () => {
    const near = findDuplicateParties({ name: 'Sharma Traderz' }, existing);
    expect(near[0]).toMatchObject({ id: '1', reasons: ['similar_name'] });
    expect(findDuplicateParties({ name: 'Brand New Business' }, existing)).toEqual([]);
    expect(findDuplicateParties({ name: '' }, existing)).toEqual([]);
  });

  it.each(DIALECTS)(
    'rule reads parties from the database (%s)',
    async (dialect) => {
      const d = await openTestDb(dialect);
      opened.push(d);
      const ctx = await tenant(d);
      await new PartyRepo(d).create(ctx, {
        type: 'customer',
        name: 'Sharma Traders',
        gstin: '27AAPFU0939F1ZV',
        phone: '9876543210',
      });
      const rules = new RulesProvider(createDbRulesEnv(d, ctx));
      const r = await rules.suggest(
        { feature: 'duplicate_party', input: { name: 'sharma traders', gstin: '27AAPFU0939F1ZV' } },
        duplicatePartySchema,
      );
      expect(r.ok && r.value.matches[0]?.reasons).toContain('gstin');
      expect(r.ok && r.confidence).toBe(0.98);
      const clean = await rules.suggest(
        { feature: 'duplicate_party', input: { name: 'Nobody Here' } },
        duplicatePartySchema,
      );
      expect(clean.ok && clean.value.matches).toEqual([]);
    },
    60_000,
  );
});

describe('call log', () => {
  it.each(DIALECTS)(
    'stores metadata only (%s)',
    async (dialect) => {
      const d = await openTestDb(dialect);
      opened.push(d);
      const ctx = await tenant(d);
      await insertHsnEntries(d, master);
      const router = new AiRouter({
        settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
        providers: [new RulesProvider(createDbRulesEnv(d, ctx))],
        logger: new DbCallLogger(d, ctx),
      });
      await router.suggest(
        { feature: 'hsn_lookup', input: { description: 'PRIVATE copper wire text' } },
        hsnSuggestionsSchema,
      );
      const { runInTx } = await import('@gst/db');
      const rows: Record<string, unknown>[] = await runInTx(d, ctx, (tx) =>
        tx.select().from(d.schema.ai_calls),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        feature: 'hsn_lookup',
        capability: 'suggest',
        provider: 'rules',
        outcome: 'ok',
      });
      expect(Number(rows[0]?.['latency_ms'])).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(rows)).not.toContain('PRIVATE');
      expect(Object.keys(rows[0] ?? {})).not.toEqual(
        expect.arrayContaining(['prompt', 'response', 'content']),
      );
    },
    60_000,
  );
});
