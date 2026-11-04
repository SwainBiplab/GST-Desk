import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, createOrganisation } from './aggregates';
import { ConflictError, RuleError, type Ctx } from './base';
import { TemplateRepo } from './templates';

async function tenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

describe.each(DIALECTS)('print templates (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let repo: TemplateRepo;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    repo = new TemplateRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  const spec = (n: number) => ({ v: 1, name: `T${n}`, marker: n });

  it('saves, lists by name, updates with a version check and deletes', async () => {
    const b = await repo.createTemplate(ctx, 'Wholesale', spec(1));
    const a = await repo.createTemplate(ctx, 'Alpha', spec(2));
    expect((await repo.listTemplates(ctx)).map((r) => r['name'])).toEqual(['Alpha', 'Wholesale']);
    expect(b['config_json']).toEqual(spec(1));

    const upd = await repo.updateTemplate(ctx, b['id'], b['version'], 'Wholesale A4', spec(3));
    expect(upd).toMatchObject({ name: 'Wholesale A4', version: 2 });
    expect((upd['config_json'] as { marker: number }).marker).toBe(3);
    await expect(repo.updateTemplate(ctx, b['id'], 1, 'x', spec(4))).rejects.toThrow(ConflictError);

    await repo.deleteTemplate(ctx, a['id'], a['version']);
    expect((await repo.listTemplates(ctx)).map((r) => r['name'])).toEqual(['Wholesale A4']);
  });

  it('refuses a blank name, a repeated name (any case) and an oversized template', async () => {
    await expect(repo.createTemplate(ctx, '  ', spec(1))).rejects.toThrow(/name/);
    await repo.createTemplate(ctx, 'Retail Roll', spec(1));
    await expect(repo.createTemplate(ctx, 'retail roll', spec(2))).rejects.toThrow(
      /already exists/,
    );
    await expect(repo.createTemplate(ctx, 'Huge', { blob: 'x'.repeat(70_000) })).rejects.toThrow(
      /too large/,
    );
  });

  it('keeps defaults per document type and shell, and falls back to Classic', async () => {
    const own = await tenant(d);
    expect(await repo.resolveId(own, 'tax_invoice', 'books')).toBe('preset:classic');
    const t = await repo.createTemplate(own, 'Mine', spec(1));
    await repo.setDefault(own, 'tax_invoice', 'books', t['id']);
    await repo.setDefault(own, 'tax_invoice', 'shop', 'preset:retail');
    expect(await repo.resolveId(own, 'tax_invoice', 'books')).toBe(t['id']);
    expect(await repo.resolveId(own, 'tax_invoice', 'shop')).toBe('preset:retail');
    // another type is untouched
    expect(await repo.resolveId(own, 'quotation', 'books')).toBe('preset:classic');
    // clearing returns to the fallback
    await repo.setDefault(own, 'tax_invoice', 'shop', null);
    expect(await repo.resolveId(own, 'tax_invoice', 'shop')).toBe('preset:classic');
    expect(await repo.getDefaults(own)).toEqual({ tax_invoice: { books: t['id'] } });
  });

  it('a default must be a template that exists, and cannot be deleted while it is one', async () => {
    const own = await tenant(d);
    await expect(
      repo.setDefault(own, 'tax_invoice', 'books', '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(RuleError);
    const t = await repo.createTemplate(own, 'Mine', spec(1));
    await repo.setDefault(own, 'credit_note', 'shop', t['id']);
    await expect(repo.deleteTemplate(own, t['id'], t['version'])).rejects.toThrow(
      /default for credit note in shop/,
    );
    await repo.setDefault(own, 'credit_note', 'shop', null);
    await repo.deleteTemplate(own, t['id'], t['version']);
  });

  it('a default that points at a deleted template falls back instead of failing a print', async () => {
    const own = await tenant(d);
    const t = await repo.createTemplate(own, 'Gone', spec(1));
    await repo.setDefault(own, 'tax_invoice', 'books', t['id']);
    // simulate it being removed behind the setting's back
    await new TemplateRepo(d).softDelete(own, t['id'], t['version']);
    expect(await repo.resolveId(own, 'tax_invoice', 'books')).toBe('preset:classic');
  });

  it('is private to its business', async () => {
    const other = await tenant(d);
    expect(await repo.listTemplates(other)).toEqual([]);
  });
});
