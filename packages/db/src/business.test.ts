import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from './database';
import * as aggregates from './repositories/aggregates';
import {
  AttachmentRepo,
  BusinessRepo,
  DocumentRepo,
  PartyRepo,
  PaymentRepo,
  createOrganisation,
  listBusinesses,
} from './repositories/aggregates';
import { BaseRepo, RuleError, type Ctx } from './repositories/base';
import { computeLine } from './repositories/line-math';
import * as stats from './repositories/stats';
import { DIALECTS, openTestDb } from './testing/harness';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function setup(d: Database, values: Record<string, unknown> = {}) {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Demo',
    state_code: '27',
    ...values,
  });
  return { ctx: { ...base, businessId: biz['id'] } as Ctx, biz };
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
const doc = (type: string) => ({
  type,
  date: '2026-05-01',
  total_taxable_paise: calc.taxable_paise,
  total_cgst_paise: calc.cgst_paise,
  total_sgst_paise: calc.sgst_paise,
  total_paise: calc.total_paise,
});

/** Repository methods whose first argument is a tx or an internal detail, not the public API. */
const INTERNAL =
  /In$|^(constructor|beforeSoftDelete|byIds|isReferenced|check|insertLines|linesOf|assertCanIssue|find|seedDefaults)$/;

/** Arguments that survive any argument validation done before the first database access. */
const ARGS: Record<string, unknown[]> = {
  createWithLines: [{}, []],
  record: [{}, []],
  post: [[]],
  cancel: ['00000000-0000-0000-0000-000000000000', 1, 'reason'],
  issue: ['00000000-0000-0000-0000-000000000000', 1, 'N-1'],
  register: [
    {
      ownerTable: 't',
      ownerId: 'o',
      fileName: 'f',
      mime: 'm',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      storagePath: 'p',
    },
  ],
};
const DEFAULT_ARGS = ['00000000-0000-0000-0000-000000000000', 1, {}];

function methodsOf(cls: { prototype: object }): string[] {
  const names = new Set<string>();
  for (
    let p: object | null = cls.prototype;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const n of Object.getOwnPropertyNames(p)) {
      const desc = Object.getOwnPropertyDescriptor(p, n);
      if (typeof desc?.value === 'function' && !INTERNAL.test(n)) names.add(n);
    }
  }
  return [...names];
}

describe.each(DIALECTS)('every repository call needs a business (%s)', (dialect) => {
  it('rejects every public method before touching the database when businessId is missing', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    let transactions = 0;
    const real = d.db.transaction.bind(d.db);
    d.db.transaction = (...a: unknown[]) => {
      transactions += 1;
      return real(...a);
    };

    const classes: [string, new (db: Database) => object][] = Object.entries(aggregates)
      .filter(([, v]) => typeof v === 'function' && /^[A-Z]\w+Repo$/.test(v.name))
      .map(([k, v]) => [k, v as never]);
    classes.push([
      'BaseRepo',
      class extends BaseRepo {
        constructor(db: Database) {
          super(db, 'parties');
        }
      } as never,
    ]);
    expect(classes.map(([k]) => k)).toEqual(
      expect.arrayContaining([
        'BusinessRepo',
        'PartyRepo',
        'ItemRepo',
        'DocumentRepo',
        'PaymentRepo',
        'LedgerRepo',
        'ReviewRepo',
        'AuditRepo',
        'SettingsRepo',
        'AttachmentRepo',
      ]),
    );

    const noBusiness = { orgId: '', businessId: '', actor: 'x', deviceId: 'x' } as Ctx;
    const noOrg = { orgId: '', businessId: crypto.randomUUID(), actor: 'x', deviceId: 'x' } as Ctx;
    const failures: string[] = [];
    let called = 0;
    for (const [name, Cls] of classes) {
      const repo = new Cls(d) as Record<string, (...a: unknown[]) => Promise<unknown>>;
      for (const method of methodsOf(Cls as never)) {
        if (name === 'BusinessRepo' && method === 'create') continue; // creating a business is the one exception
        for (const ctx of [noBusiness, noOrg]) {
          called += 1;
          try {
            await repo[method]!(ctx, ...(ARGS[method] ?? DEFAULT_ARGS));
            failures.push(`${name}.${method} ran without a business`);
          } catch (e) {
            if (!(e instanceof RuleError) || !/businessId/.test(e.message)) {
              failures.push(`${name}.${method}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    }
    expect(called).toBeGreaterThan(40);

    // the standalone query helpers too
    for (const [name, fn] of [
      ['getCounts', () => stats.getCounts(d, noBusiness)],
      ['getTodaySummary', () => stats.getTodaySummary(d, noBusiness, '2026-01-01')],
      ['getRecent', () => stats.getRecent(d, noBusiness)],
      ['getOnboardingFacts', () => stats.getOnboardingFacts(d, noBusiness)],
    ] as const) {
      await expect(fn(), name).rejects.toThrow(/businessId/);
    }

    expect(failures).toEqual([]);
    expect(transactions).toBe(0);
  }, 60_000);

  it('still lets a business be created without one', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { biz } = await setup(d);
    expect(biz['id']).toBeTruthy();
  }, 60_000);
});

describe.each(DIALECTS)('composition scheme (%s)', (dialect) => {
  it('hard-blocks tax invoices and allows bills of supply', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx } = await setup(d, { scheme: 'composition' });
    const docs = new DocumentRepo(d);
    await expect(
      docs.createWithLines(ctx, doc('tax_invoice'), [{ ...line, ...calc }]),
    ).rejects.toThrow(/composition scheme.*Bill of Supply/);
    const bos = await docs.createWithLines(ctx, doc('bill_of_supply'), [{ ...line, ...calc }]);
    expect(bos.document['type']).toBe('bill_of_supply');
    expect((await docs.list(ctx)).map((x) => x['type'])).toEqual(['bill_of_supply']);
  }, 60_000);

  it('blocks issuing a tax invoice drafted before the business switched to composition', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, biz } = await setup(d);
    const docs = new DocumentRepo(d);
    const draft = await docs.createWithLines(ctx, doc('tax_invoice'), [{ ...line, ...calc }]);
    await new BusinessRepo(d).update(ctx, { scheme: 'composition' }, biz['version']);
    await expect(docs.issue(ctx, draft.document['id'], 1, 'INV-1')).rejects.toBeInstanceOf(
      RuleError,
    );
    await new BusinessRepo(d).update(ctx, { scheme: 'regular' }, biz['version'] + 1);
    await expect(docs.issue(ctx, draft.document['id'], 1, 'INV-1')).resolves.toBeDefined();
  }, 60_000);
});

describe.each(DIALECTS)('businesses and attachments (%s)', (dialect) => {
  it('archives a business but never the last one, and keeps them apart', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, biz } = await setup(d, { legal_name: 'First' });
    const second = await new BusinessRepo(d).create(ctx, {
      legal_name: 'Second',
      state_code: '29',
    });
    const ctx2: Ctx = { ...ctx, businessId: second['id'] };

    await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Only in first' });
    expect(await new PartyRepo(d).list(ctx2)).toEqual([]);
    expect((await listBusinesses(d, ctx.orgId)).map((b) => b['legal_name'])).toEqual([
      'First',
      'Second',
    ]);

    await new BusinessRepo(d).archive(ctx, second['id'], second['version']);
    expect((await listBusinesses(d, ctx.orgId)).map((b) => b['legal_name'])).toEqual(['First']);
    await expect(new BusinessRepo(d).archive(ctx, biz['id'], biz['version'])).rejects.toThrow(
      /last business/,
    );
  }, 60_000);

  it('registers attachments by hash without duplicating, and lists them per owner', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx, biz } = await setup(d);
    const repo = new AttachmentRepo(d);
    const file = {
      ownerTable: 'businesses',
      ownerId: biz['id'],
      fileName: 'logo.png',
      mime: 'image/png',
      sizeBytes: 1234,
      sha256: 'ab'.repeat(32),
      storagePath: 'attachments/abab',
    };
    const a = await repo.register(ctx, file);
    const again = await repo.register(ctx, file);
    expect(again['id']).toBe(a['id']);
    await repo.register(ctx, { ...file, sha256: 'cd'.repeat(32), fileName: 'stamp.png' });
    expect(
      (await repo.forOwner(ctx, 'businesses', biz['id'])).map((x) => x['file_name']).sort(),
    ).toEqual(['logo.png', 'stamp.png']);
    await expect(repo.register(ctx, { ...file, sha256: 'xyz' })).rejects.toBeInstanceOf(RuleError);
  }, 60_000);

  it('reports onboarding facts', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx } = await setup(d);
    expect(await stats.getOnboardingFacts(d, ctx)).toEqual({
      parties: 0,
      items: 0,
      issuedSales: 0,
      payments: 0,
    });
    await new PartyRepo(d).create(ctx, { type: 'customer', name: 'A' });
    const docs = new DocumentRepo(d);
    const c = await docs.createWithLines(ctx, doc('tax_invoice'), [{ ...line, ...calc }]);
    await docs.issue(ctx, c.document['id'], 1, 'INV-1');
    await new PaymentRepo(d).record(ctx, { date: '2026-05-01', mode: 'cash', amount_paise: 100 });
    expect(await stats.getOnboardingFacts(d, ctx)).toEqual({
      parties: 1,
      items: 0,
      issuedSales: 1,
      payments: 1,
    });
  }, 60_000);
});
