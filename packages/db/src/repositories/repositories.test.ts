import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { execRaw, type Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import {
  AuditRepo,
  BusinessRepo,
  DocumentRepo,
  ItemRepo,
  LedgerRepo,
  PartyRepo,
  PaymentRepo,
  ReviewRepo,
  SettingsRepo,
  createOrganisation,
} from './aggregates';
import { BaseRepo, ConflictError, RuleError, runInTx, type Ctx } from './base';
import { insertHsnEntries, searchHsn } from './hsn';
import { computeLine } from './line-math';

async function newTenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev-1' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Demo Traders',
    state_code: '27',
    gstin: '27AAPFU0939F1ZV',
  });
  return { ...base, businessId: biz['id'] };
}

/** A fully consistent single-line invoice (intra-state 18%). */
function invoice(extra: Record<string, unknown> = {}) {
  const line: Record<string, any> = {
    qty_micros: 2_000_000,
    rate_paise: 50_000,
    discount_mode: 'none',
    discount_value: 0,
    cgst_bp: 900,
    sgst_bp: 900,
  };
  const calc = computeLine(line);
  const lineRow = { ...line, ...calc };
  const doc = {
    type: 'tax_invoice',
    date: '2026-04-10',
    total_taxable_paise: calc.taxable_paise,
    total_cgst_paise: calc.cgst_paise,
    total_sgst_paise: calc.sgst_paise,
    total_paise: calc.total_paise,
    ...extra,
  };
  return { doc, lines: [lineRow] };
}

describe.each(DIALECTS)('repositories (%s)', (dialect) => {
  let d: Database;
  beforeAll(async () => {
    d = await openTestDb(dialect);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('creates, reads, updates and audits a party', async () => {
    const ctx = await newTenant(d);
    const parties = new PartyRepo(d);
    const p = await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma Traders',
      gstin: '27AAAAA0000A1Z5',
    });
    expect(p['version']).toBe(1);
    expect(p['created_by']).toBe('tester');

    const u = await parties.update(ctx, p['id'], { name: 'Sharma & Sons' }, 1);
    expect(u['version']).toBe(2);
    expect((await parties.get(ctx, p['id']))?.['name']).toBe('Sharma & Sons');

    const trail = await new AuditRepo(d).forRow(ctx, 'parties', p['id']);
    expect(trail.map((a) => a['action'])).toEqual(['insert', 'update']);
    expect(trail[1]?.['before_json']?.name).toBe('Sharma Traders');
    expect(trail[1]?.['after_json']?.name).toBe('Sharma & Sons');
  });

  it('rejects stale writes with ConflictError', async () => {
    const ctx = await newTenant(d);
    const parties = new PartyRepo(d);
    const p = await parties.create(ctx, { type: 'customer', name: 'A' });
    await parties.update(ctx, p['id'], { name: 'B' }, 1);
    await expect(parties.update(ctx, p['id'], { name: 'C' }, 1)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await parties.get(ctx, p['id']))?.['name']).toBe('B');
  });

  it('does not leak rows across businesses', async () => {
    const a = await newTenant(d);
    const b = await newTenant(d);
    const parties = new PartyRepo(d);
    const p = await parties.create(a, { type: 'customer', name: 'Only A' });
    expect(await parties.get(b, p['id'])).toBeNull();
    expect(await parties.list(b)).toEqual([]);
  });

  it('soft-deletes unreferenced parties and blocks referenced ones', async () => {
    const ctx = await newTenant(d);
    const parties = new PartyRepo(d);
    const docs = new DocumentRepo(d);
    const free = await parties.create(ctx, { type: 'customer', name: 'Free' });
    const used = await parties.create(ctx, { type: 'customer', name: 'Used' });
    const { doc, lines } = invoice({ party_id: used['id'] });
    await docs.createWithLines(ctx, doc, lines);

    await parties.softDelete(ctx, free['id'], 1);
    expect(await parties.get(ctx, free['id'])).toBeNull();
    await expect(parties.softDelete(ctx, used['id'], 1)).rejects.toBeInstanceOf(RuleError);
  });

  it('blocks soft-deleting an item that has document lines', async () => {
    const ctx = await newTenant(d);
    const items = new ItemRepo(d);
    const docs = new DocumentRepo(d);
    const item = await items.create(ctx, { name: 'Widget', hsn: '8517' });
    const { doc, lines } = invoice();
    await docs.createWithLines(ctx, doc, [{ ...lines[0]!, item_id: item['id'] }]);
    await expect(items.softDelete(ctx, item['id'], 1)).rejects.toBeInstanceOf(RuleError);
  });

  it('forbids hard deletes at the database level', async () => {
    const ctx = await newTenant(d);
    const p = await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Keep me' });
    await expect(
      runInTx(d, ctx, (tx) => execRaw(d, tx, `DELETE FROM parties WHERE id = '${p['id']}'`)),
    ).rejects.toThrow();
    expect(await new PartyRepo(d).get(ctx, p['id'])).not.toBeNull();
  });

  it('only allows draft documents to be soft-deleted (repo and trigger)', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const { doc, lines } = invoice();
    const draft = (await docs.createWithLines(ctx, doc, lines)).document;
    const issued = (await docs.createWithLines(ctx, doc, lines)).document;
    await docs.issue(ctx, issued['id'], 1, 'INV-1');

    await docs.softDelete(ctx, draft['id'], 1);
    await expect(docs.softDelete(ctx, issued['id'], 2)).rejects.toBeInstanceOf(RuleError);
    // bypass the repo: the trigger must still refuse
    await expect(
      runInTx(d, ctx, (tx) =>
        execRaw(d, tx, `UPDATE documents SET deleted_at = 1 WHERE id = '${issued['id']}'`),
      ),
    ).rejects.toThrow();
  });

  it('keeps issued document numbers unique per type', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const { doc, lines } = invoice();
    const a = (await docs.createWithLines(ctx, doc, lines)).document;
    const b = (await docs.createWithLines(ctx, doc, lines)).document;
    const c = (await docs.createWithLines(ctx, { ...doc, type: 'quotation' }, lines)).document;

    await docs.issue(ctx, a['id'], 1, 'INV-001');
    await expect(docs.issue(ctx, b['id'], 1, 'INV-001')).rejects.toThrow();
    await docs.issue(ctx, c['id'], 1, 'INV-001'); // different type is fine
    await docs.issue(ctx, b['id'], 1, 'INV-002');
  });

  it('cancels issued documents and keeps the number', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const { doc, lines } = invoice();
    const a = (await docs.createWithLines(ctx, doc, lines)).document;
    await expect(docs.cancel(ctx, a['id'], 1, 'oops')).rejects.toBeInstanceOf(RuleError);
    await docs.issue(ctx, a['id'], 1, 'INV-9');
    const c = await docs.cancel(ctx, a['id'], 2, 'duplicate');
    expect(c['status']).toBe('cancelled');
    expect(c['number']).toBe('INV-9');
  });

  it('rejects documents whose money does not match recomputation', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const { doc, lines } = invoice();
    await expect(
      docs.createWithLines(ctx, doc, [{ ...lines[0]!, total_paise: lines[0]!.total_paise + 1 }]),
    ).rejects.toThrow(/total_paise/);
    await expect(docs.createWithLines(ctx, { ...doc, total_paise: 1 }, lines)).rejects.toThrow(
      /document/,
    );
  });

  it('replaces draft lines and refuses edits after issue', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const { doc, lines } = invoice();
    const created = await docs.createWithLines(ctx, doc, lines);
    const next = invoice({ date: '2026-04-11' });
    const updated = await docs.updateDraft(
      ctx,
      created.document['id'],
      1,
      { date: '2026-04-11' },
      next.lines,
    );
    expect(updated.lines).toHaveLength(1);
    const reread = await docs.getWithLines(ctx, created.document['id']);
    expect(reread?.lines).toHaveLength(1);
    expect(reread?.document['date']).toBe('2026-04-11');

    await docs.issue(ctx, created.document['id'], updated.document['version'], 'INV-5');
    await expect(
      docs.updateDraft(ctx, created.document['id'], 3, { notes: 'x' }),
    ).rejects.toBeInstanceOf(RuleError);
  });

  it('finds parties, items and documents with full-text search', async () => {
    const ctx = await newTenant(d);
    const parties = new PartyRepo(d);
    const items = new ItemRepo(d);
    const docs = new DocumentRepo(d);
    await parties.create(ctx, {
      type: 'customer',
      name: 'Sharma Traders',
      gstin: '27AAAAA0000A1Z5',
    });
    await parties.create(ctx, { type: 'customer', name: 'Iyer & Sons' });
    await items.create(ctx, { name: 'Copper Wire 2.5mm', sku: 'CW-25', hsn: '7408' });
    const { doc, lines } = invoice({ party_name: 'Sharma Traders', notes: 'festival order' });
    const created = await docs.createWithLines(ctx, doc, lines);
    await docs.issue(ctx, created.document['id'], 1, 'INV-2026-0042');

    expect((await parties.search(ctx, 'sharm')).map((r) => r['name'])).toEqual(['Sharma Traders']);
    expect((await parties.search(ctx, '27AAAAA0000A1Z5')).length).toBe(1);
    expect((await parties.search(ctx, 'nothing-here')).length).toBe(0);
    expect((await items.search(ctx, 'copper wire')).map((r) => r['sku'])).toEqual(['CW-25']);
    expect((await docs.search(ctx, 'festival')).length).toBe(1);

    // soft-deleted rows drop out of search
    const iyer = (await parties.search(ctx, 'iyer'))[0]!;
    await parties.softDelete(ctx, iyer['id'], 1);
    expect(await parties.search(ctx, 'iyer')).toEqual([]);
  });

  it('keeps search scoped to the business', async () => {
    const a = await newTenant(d);
    const b = await newTenant(d);
    const parties = new PartyRepo(d);
    await parties.create(a, { type: 'customer', name: 'Zebra Corp' });
    expect(await parties.search(b, 'zebra')).toEqual([]);
  });

  it('posts balanced ledger entries only', async () => {
    const ctx = await newTenant(d);
    const ledger = new LedgerRepo(d);
    const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
    const cash = accounts.find((a) => a['code'] === '1000')!;
    const sales = accounts.find((a) => a['code'] === '4000')!;
    await expect(
      ledger.post(ctx, [
        { account_id: cash['id'], debit_paise: 100, date: '2026-04-01' },
        { account_id: sales['id'], credit_paise: 90, date: '2026-04-01' },
      ]),
    ).rejects.toBeInstanceOf(RuleError);
    await ledger.post(ctx, [
      { account_id: cash['id'], debit_paise: 500, date: '2026-04-01' },
      { account_id: sales['id'], credit_paise: 500, date: '2026-04-01' },
    ]);
    const tb = await ledger.trialBalance(ctx);
    expect(tb.find((r) => r.account_id === cash['id'])?.debit_paise).toBe(500);
    expect(tb.find((r) => r.account_id === sales['id'])?.credit_paise).toBe(500);
  });

  it('records payments with allocations and caps over-allocation', async () => {
    const ctx = await newTenant(d);
    const docs = new DocumentRepo(d);
    const payments = new PaymentRepo(d);
    const { doc, lines } = invoice();
    const created = await docs.createWithLines(ctx, doc, lines);
    await docs.issue(ctx, created.document['id'], 1, 'INV-77');
    await expect(
      payments.record(ctx, { date: '2026-04-12', mode: 'upi', amount_paise: 100 }, [
        { document_id: created.document['id'], amount_paise: 200 },
      ]),
    ).rejects.toBeInstanceOf(RuleError);
    const r = await payments.record(ctx, { date: '2026-04-12', mode: 'upi', amount_paise: 5000 }, [
      { document_id: created.document['id'], amount_paise: 5000 },
    ]);
    expect(await payments.allocationsFor(ctx, r.payment['id'])).toHaveLength(1);
  });

  it('upserts settings and tracks versions', async () => {
    const ctx = await newTenant(d);
    const s = new SettingsRepo(d);
    await s.set(ctx, 'invoice.footer', { text: 'Thanks' });
    await s.set(ctx, 'invoice.footer', { text: 'Thank you' });
    expect(await s.getValue(ctx, 'invoice.footer')).toEqual({ text: 'Thank you' });
    expect(await s.getValue(ctx, 'missing')).toBeUndefined();
  });

  it('accepts review items with actor and timestamp', async () => {
    const ctx = await newTenant(d);
    const reviews = new ReviewRepo(d);
    const r = await reviews.create(ctx, { kind: 'hsn_suggestion', payload_json: { x: 1 } });
    expect(await reviews.pending(ctx)).toHaveLength(1);
    const accepted = await reviews.accept(ctx, r['id'], 1);
    expect(accepted['accepted_by']).toBe('tester');
    expect(await reviews.pending(ctx)).toHaveLength(0);
  });

  it('makes audit_log append-only', async () => {
    const ctx = await newTenant(d);
    await new PartyRepo(d).create(ctx, { type: 'customer', name: 'X' });
    await expect(
      runInTx(d, ctx, (tx) => execRaw(d, tx, `UPDATE audit_log SET actor = 'evil'`)),
    ).rejects.toThrow();
  });

  it('rolls back everything when a transaction fails', async () => {
    const ctx = await newTenant(d);
    const parties = new PartyRepo(d);
    await expect(
      runInTx(d, ctx, async (tx) => {
        await parties.create({ ...ctx, tx }, { type: 'customer', name: 'Ghost' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await parties.search(ctx, 'ghost')).toEqual([]);
    expect(await parties.list(ctx)).toEqual([]);
  });
});

describe('row-level security (pg)', () => {
  let d: Database;
  beforeAll(async () => {
    d = await openTestDb('pg');
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('returns zero rows for another tenant and refuses cross-tenant writes', async () => {
    const a = await newTenant(d);
    const b = await newTenant(d);
    const parties = new PartyRepo(d);
    await parties.create(a, { type: 'customer', name: 'Tenant A only' });

    // Query the table directly (no business_id filter) under tenant B's org context.
    const asB = await runInTx(d, b, (tx) => tx.execute(sql`SELECT id FROM parties`));
    expect((asB as any).rows).toHaveLength(0);
    const asA = await runInTx(d, a, (tx) => tx.execute(sql`SELECT id FROM parties`));
    expect((asA as any).rows).toHaveLength(1);

    // Tenant B cannot insert a row claiming tenant A's org.
    await expect(
      runInTx(d, b, (tx) =>
        tx.execute(
          sql`INSERT INTO parties (id, org_id, business_id, type, name) VALUES (${crypto.randomUUID()}, ${a.orgId}, ${a.businessId}, 'customer', 'x')`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe.each(DIALECTS)('hsn search (%s)', (dialect) => {
  it('ranks by relevance, honours effective dates and stems words', async () => {
    const d = await openTestDb(dialect);
    await insertHsnEntries(d, [
      { code: '7408', description: 'Copper wire', rate_bp: 1800, effective_from: '2017-07-01' },
      {
        code: '8544',
        description: 'Insulated electric wire, cable and other insulated electric conductors',
        rate_bp: 1800,
        effective_from: '2017-07-01',
      },
      {
        code: '5208',
        description: 'Woven fabrics of cotton',
        rate_bp: 500,
        effective_from: '2017-07-01',
      },
      {
        code: '9999',
        description: 'Old copper scheme',
        rate_bp: 1200,
        effective_from: '2017-07-01',
        effective_to: '2019-12-31',
      },
    ]);
    const hits = await searchHsn(d, 'copper wires');
    expect(hits[0]?.code).toBe('7408');
    expect(hits.map((h) => h.code)).toContain('8544');
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect((await searchHsn(d, 'copper', { asOf: '2026-01-01' })).map((h) => h.code)).not.toContain(
      '9999',
    );
    expect((await searchHsn(d, 'copper', { asOf: '2018-01-01' })).map((h) => h.code)).toContain(
      '9999',
    );
    expect(await searchHsn(d, '   ')).toEqual([]);
    expect(await searchHsn(d, 'zzzzzz')).toEqual([]);
    await d.close();
  }, 60_000);
});
