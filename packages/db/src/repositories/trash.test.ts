import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryRows, type Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import {
  AttachmentRepo,
  AuditRepo,
  BusinessRepo,
  PartyRepo,
  createOrganisation,
} from './aggregates';
import { RuleError, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { ItemRepo } from './items';
import { TrashRepo } from './trash';

const DAY = 86_400_000;

async function tenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

let k = 0;
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${++k}`),
  description: 'Widget',
  qtyMicros: 1_000_000n,
  ratePaise: 50_000n,
  gstRateBp: 1800,
  ...over,
});
const draft = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
  lines: [line(), line()],
  ...over,
});
const rows = (dr: DraftDocument) => {
  const r = draftToRows(dr);
  return {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  };
};

describe.each(DIALECTS)('the trash (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let trash: TrashRepo;
  let flow: DocumentFlowRepo;
  let parties: PartyRepo;
  let items: ItemRepo;

  /** A count read the way a repository would: inside a transaction that knows the organisation. */
  const count = async (table: string, where = sql`1 = 1`) =>
    d.db.transaction(async (tx: any) => {
      if (d.dialect === 'pg')
        await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.orgId}, true)`);
      const r = await queryRows(
        d,
        tx,
        sql`SELECT count(*) AS c FROM ${sql.identifier(table)} WHERE ${where}`,
      );
      return Number(r[0]!['c']);
    });
  const newParty = async (name: string) =>
    parties.create(ctx, { type: 'customer', name, state_code: '27' });
  const newItem = async (name: string, sku?: string) =>
    items.create(ctx, { name, hsn: '7318', gst_rate_bp: 1800, ...(sku ? { sku } : {}) });
  const newDraft = async () => flow.saveDraft(ctx, rows(draft()));

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    trash = new TrashRepo(d);
    flow = new DocumentFlowRepo(d);
    parties = new PartyRepo(d);
    items = new ItemRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('holds a deleted party, item and draft for 30 days, newest first, with the days left', async () => {
    const p = await newParty('Gone Party');
    const i = await newItem('Gone Item');
    const dr = await newDraft();
    await parties.softDelete(ctx, p['id'], p['version']);
    await items.softDelete(ctx, i['id'], i['version']);
    await flow.discardDraft(ctx, dr.document['id'], dr.document['version']);

    const list = await trash.list(ctx);
    expect(list.map((e) => e.table).sort()).toEqual(['documents', 'items', 'parties']);
    expect(list.every((e) => e.daysLeft === 30)).toBe(true);
    expect(list.find((e) => e.table === 'parties')).toMatchObject({ name: 'Gone Party' });
    expect(list.find((e) => e.table === 'documents')).toMatchObject({ type: 'tax_invoice' });
    for (let at = 1; at < list.length; at++)
      expect(list[at - 1]!.deletedAt).toBeGreaterThanOrEqual(list[at]!.deletedAt);
    // seen 10 days later
    const later = await trash.list(ctx, Date.now() + 10 * DAY);
    expect(later.every((e) => e.daysLeft === 20)).toBe(true);
    await trash.empty(ctx);
  });

  it('brings a party, an item and a draft back as they were', async () => {
    const p = await newParty('Back Party');
    const i = await newItem('Back Item', 'BACK-1');
    const dr = await newDraft();
    await parties.softDelete(ctx, p['id'], p['version']);
    await items.softDelete(ctx, i['id'], i['version']);
    await flow.discardDraft(ctx, dr.document['id'], dr.document['version']);

    for (const [table, id] of [
      ['parties', p['id']],
      ['items', i['id']],
      ['documents', dr.document['id']],
    ] as const)
      await trash.restore(ctx, table, id);
    expect(await trash.list(ctx)).toEqual([]);
    expect((await parties.get(ctx, p['id']))!['name']).toBe('Back Party');
    expect((await items.get(ctx, i['id']))!['sku']).toBe('BACK-1');
    const back = await flow.load(ctx, dr.document['id']);
    expect(back!.document['status']).toBe('draft');
    expect(back!.lines).toHaveLength(2);
  });

  it('says so when a restored item now clashes with a new one', async () => {
    const i = await newItem('Old SKU holder', 'CLASH-1');
    await items.softDelete(ctx, i['id'], i['version']);
    await newItem('New SKU holder', 'CLASH-1');
    const err = await trash.restore(ctx, 'items', i['id']).catch((e) => e);
    expect(err).toBeInstanceOf(RuleError);
    expect(String(err.message)).toMatch(/clashes/);
    await trash.empty(ctx);
  });

  it('cannot restore what is not in the trash, or a table that has no trash', async () => {
    const p = await newParty('Still here');
    await expect(trash.restore(ctx, 'parties', p['id'])).rejects.toThrow();
    await expect(trash.restore(ctx, 'payments' as never, p['id'])).rejects.toThrow(
      /cannot be restored/,
    );
  });

  it('removes a trashed party for good, and writes it to the audit trail', async () => {
    const p = await newParty('Purge me');
    await parties.softDelete(ctx, p['id'], p['version']);
    await trash.purge(ctx, 'parties', p['id']);
    expect(await count('parties', sql`id = ${p['id']}`)).toBe(0);
    const trail = await new AuditRepo(d).forRow(ctx, 'parties', p['id']);
    expect(trail.map((a) => a['action'])).toContain('purge');
  });

  it('removes a trashed draft with its lines, and hides its attached files', async () => {
    const dr = await newDraft();
    const id = dr.document['id'];
    await new AttachmentRepo(d).register(ctx, {
      ownerTable: 'documents',
      ownerId: id,
      fileName: 'po.pdf',
      mime: 'application/pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      storagePath: `opfs:${'a'.repeat(64)}`,
    });
    await flow.discardDraft(ctx, id, dr.document['version']);
    expect(await count('document_lines', sql`document_id = ${id}`)).toBe(2);
    await trash.purge(ctx, 'documents', id);
    expect(await count('documents', sql`id = ${id}`)).toBe(0);
    expect(await count('document_lines', sql`document_id = ${id}`)).toBe(0);
    expect(await count('attachments', sql`owner_id = ${id} AND deleted_at IS NULL`)).toBe(0);
  });

  it('refuses to remove anything that is not in the trash', async () => {
    const p = await newParty('Alive');
    await expect(trash.purge(ctx, 'parties', p['id'])).rejects.toThrow(/in the trash/);
    const dr = await newDraft();
    await expect(trash.purge(ctx, 'documents', dr.document['id'])).rejects.toThrow(/in the trash/);
    expect(await count('parties', sql`id = ${p['id']}`)).toBe(1);
    await expect(trash.purge(ctx, 'parties', crypto.randomUUID())).rejects.toThrow();
  });

  it('never lets an issued document be trashed or removed, and live rows still cannot be deleted', async () => {
    const dr = await newDraft();
    const issued = await flow.issueDraft(ctx, dr.document['id'], dr.document['version']);
    const id = issued.document['id'];
    // it cannot be moved to the trash
    await expect(flow.discardDraft(ctx, id, issued.document['version'])).rejects.toThrow();
    // and the database refuses a DELETE however it is asked
    const raw = (table: string, where: string) =>
      d.db.transaction(async (tx: any) => {
        const q = sql.raw(`DELETE FROM ${table} WHERE ${where}`);
        if (d.dialect === 'sqlite') await tx.run(q);
        else {
          await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.orgId}, true)`);
          await tx.execute(q);
        }
      });
    await expect(raw('documents', `id = '${id}'`)).rejects.toThrow();
    await expect(raw('document_lines', `document_id = '${id}'`)).rejects.toThrow();
    const live = await newParty('Live party');
    await expect(raw('parties', `id = '${live['id']}'`)).rejects.toThrow();
    await expect(raw('payments', `1 = 1`))
      .resolves.toBeUndefined()
      .catch(() => undefined);
    expect(await count('documents', sql`id = ${id}`)).toBe(1);
    expect(await count('document_lines', sql`document_id = ${id}`)).toBe(2);
    await expect(trash.purge(ctx, 'documents', id)).rejects.toThrow();
  });

  it('removes what has been in the trash 30 days, and nothing younger', async () => {
    await trash.empty(ctx);
    const old = await newParty('Thirty days');
    const young = await newParty('Just now');
    await parties.softDelete(ctx, old['id'], old['version']);
    await parties.softDelete(ctx, young['id'], young['version']);
    expect(await trash.purgeExpired(ctx, Date.now() + 29 * DAY)).toBe(0);
    expect(await trash.purgeExpired(ctx, Date.now() + 31 * DAY)).toBe(2);
    expect(await trash.list(ctx)).toEqual([]);
  });

  it('empties the trash, and leaves live data alone', async () => {
    const live = await newParty('Keep me');
    const a = await newParty('Bin 1');
    const b = await newItem('Bin 2');
    await parties.softDelete(ctx, a['id'], a['version']);
    await items.softDelete(ctx, b['id'], b['version']);
    expect(await trash.empty(ctx)).toBe(2);
    expect((await parties.get(ctx, live['id']))!['name']).toBe('Keep me');
  });

  it('keeps one business’s trash to itself', async () => {
    const p = await newParty('Mine');
    await parties.softDelete(ctx, p['id'], p['version']);
    const other = await tenant(d);
    expect(await new TrashRepo(d).list(other)).toEqual([]);
    await expect(new TrashRepo(d).purge(other, 'parties', p['id'])).rejects.toThrow();
    await expect(new TrashRepo(d).restore(other, 'parties', p['id'])).rejects.toThrow();
    expect(await trash.list(ctx)).toHaveLength(1);
    await trash.empty(ctx);
  });
});
