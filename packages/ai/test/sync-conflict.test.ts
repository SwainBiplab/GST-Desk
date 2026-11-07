import {
  BusinessRepo,
  DocumentFlowRepo,
  PartyRepo,
  createOrganisation,
  type Ctx,
  type Database,
} from '@gst/db';
import { DIALECTS, openTestDb } from '@gst/db/testing';
import { draftToRows, emptyDraft, emptyDraftLine, type DraftDocument } from '@gst/domain';
import { afterAll, describe, expect, it } from 'vitest';

import { syncConflictItem, type SyncConflictItem } from '../src';
import { applyReviewItem, createReviewItem, rejectReviewItem } from '../src/db';

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

const draft = (partyId: string, ratePaise: bigint, notes: string): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-06-01', { supplierState: '27' }),
  partyId,
  partyName: 'Asha',
  placeOfSupply: '27',
  notes,
  lines: [
    {
      ...emptyDraftLine('a'),
      description: 'Cement',
      qtyMicros: 2_000_000n,
      ratePaise,
      gstRateBp: 2800,
    },
  ],
});

describe.each(DIALECTS)('settling a sync conflict (%s)', (dialect) => {
  it('keep mine puts my draft back on top of what the server kept; keep theirs changes nothing', async () => {
    const { d, ctx } = await setup(dialect);
    const party = await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'Asha',
      state_code: '27',
    });
    const flow = new DocumentFlowRepo(d);
    const theirsRows = draftToRows(draft(party['id'], 10_000n, 'theirs'));
    const saved = await flow.saveDraft(ctx, {
      doc: theirsRows.doc as never,
      lines: theirsRows.lines as never,
    });
    const docId = String(saved.document['id']);

    // what the other device sent: my header and my lines, as the upload carried them
    const mine = draftToRows(draft(party['id'], 12_000n, 'mine'));
    const item: SyncConflictItem = {
      table: 'documents',
      rowId: docId,
      label: 'draft',
      reason: 'the document was changed on another device',
      mine: { ...(mine.doc as unknown as Record<string, unknown>) },
      theirs: { ...(saved.document as Record<string, unknown>) },
      ops: [
        {
          op: 'PATCH',
          table: 'documents',
          id: docId,
          data: { ...(mine.doc as unknown as Record<string, unknown>), version: 3 },
        },
        ...mine.lines.map((l, i) => ({
          op: 'PUT',
          table: 'document_lines',
          id: `new-${i}`,
          data: {
            ...(l as unknown as Record<string, unknown>),
            document_id: docId,
            deleted_at: null,
          },
        })),
      ],
      deviceId: 'dev-b',
      byUser: 'user-2',
    };
    const row = await createReviewItem({
      db: d,
      ctx,
      kind: 'sync_conflict',
      payload: null,
      suggestion: item,
      schema: syncConflictItem,
      source: 'sync',
    });
    await applyReviewItem(d, ctx, row);
    const after = (await flow.load(ctx, docId))!;
    expect(after.document['notes']).toBe('mine');
    expect(after.lines.map((l) => Number(l['rate_paise']))).toEqual([12_000]);
    expect(Number(after.document['total_taxable_paise'])).toBe(24_000);

    // a second conflict, settled the other way: nothing changes
    const other = await createReviewItem({
      db: d,
      ctx,
      kind: 'sync_conflict',
      payload: null,
      suggestion: { ...item, mine: { notes: 'ignored' } },
      schema: syncConflictItem,
      source: 'sync',
      dedupeKey: 'x',
    });
    await rejectReviewItem({
      db: d,
      ctx,
      id: other['id'],
      expectedVersion: other['version'],
      reason: 'keep theirs',
    });
    expect((await flow.load(ctx, docId))!.document['notes']).toBe('mine');
  });

  it('keep mine on a plain record writes my fields; on a document issued since, it explains instead', async () => {
    const { d, ctx } = await setup(dialect);
    const party = await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'Gupta',
      state_code: '27',
    });
    const item: SyncConflictItem = {
      table: 'parties',
      rowId: party['id'],
      label: 'party',
      reason: 'x',
      mine: { phone: '9811111111', version: 9 },
      theirs: {},
      ops: [],
      deviceId: 'b',
      byUser: 'u',
    };
    const row = await createReviewItem({
      db: d,
      ctx,
      kind: 'sync_conflict',
      payload: null,
      suggestion: item,
      schema: syncConflictItem,
      source: 'sync',
    });
    await applyReviewItem(d, ctx, row);
    expect((await new PartyRepo(d).get(ctx, party['id']))!['phone']).toBe('9811111111');

    const flow = new DocumentFlowRepo(d);
    const r = draftToRows(draft(party['id'], 5_000n, ''));
    const saved = await flow.saveDraft(ctx, { doc: r.doc as never, lines: r.lines as never });
    await flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
    const late = await createReviewItem({
      db: d,
      ctx,
      kind: 'sync_conflict',
      payload: null,
      suggestion: {
        ...item,
        table: 'documents',
        rowId: saved.document['id'],
        mine: { notes: 'late' },
      },
      schema: syncConflictItem,
      source: 'sync',
      dedupeKey: 'late',
    });
    await expect(applyReviewItem(d, ctx, late)).rejects.toThrow(/issued on another device/);
  });
});
