import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AttachmentRepo,
  BusinessRepo,
  DocumentFlowRepo,
  ItemRepo,
  PartyRepo,
  ReviewRepo,
  createOrganisation,
  importHsnVersion,
  newId,
  type Ctx,
  type Database,
} from '@gst/db';
import { DIALECTS, openTestDb } from '@gst/db/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { HashEmbedder, aiExtractionItem, type AiExtractionItem } from '../src';
import {
  applyReviewItem,
  createReviewItem,
  hybridHsnLookupFor,
  indexHsnMaster,
  loadHsnVectors,
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
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Demo',
    state_code: '27',
    gstin: '27AABCU9603R1ZN',
  });
  return { d, ctx: { ...base, businessId: biz['id'] } as Ctx };
}

describe.each(DIALECTS)('HSN vectors on the database (%s)', (dialect) => {
  it('indexes the master once per model, replaces on a rerun, and the hybrid lookup forgives a misspelling', async () => {
    const { d, ctx } = await setup(dialect);
    const embedder = new HashEmbedder(64);
    const progress: number[] = [];
    const n = await indexHsnMaster(d, ctx, embedder, {
      batch: 10,
      onProgress: (done) => progress.push(done),
    });
    expect(n).toBe(MASTER.length);
    expect(progress.at(-1)).toBe(n);
    expect((await loadHsnVectors(d, embedder.model)).length).toBe(n);
    await indexHsnMaster(d, ctx, embedder);
    expect((await loadHsnVectors(d, embedder.model)).length).toBe(n);
    expect((await loadHsnVectors(d, 'other-model')).length).toBe(0);
    const lookup = await hybridHsnLookupFor(d, embedder);
    expect(lookup.constructor.name).toBe('HybridHsnLookup');
    const exact = (await lookup.search('cement', 3))[0];
    expect(exact?.code.startsWith('2523')).toBe(true);
    const typo = (await lookup.search('cemant', 3))[0];
    expect(typo?.code).toBe(exact?.code);
    expect((await hybridHsnLookupFor(d, new HashEmbedder(32))).constructor.name).toBe(
      'DbHsnLookup',
    );
  });
});

describe.each(DIALECTS)('a scanned bill in the inbox (%s)', (dialect) => {
  it('accepting makes a purchase draft priced by the engine, with the scan attached; rejecting makes nothing', async () => {
    const { d, ctx } = await setup(dialect);
    const supplier = await new PartyRepo(d).create(ctx, {
      type: 'supplier',
      name: 'Shree Ganesh Traders',
      gstin: '27AAPFU0939F1ZV',
      state_code: '27',
    });
    const cement = await new ItemRepo(d).create(ctx, {
      kind: 'goods',
      name: 'Cement OPC 53 50kg',
      hsn: '2523',
      gst_rate_bp: 2800,
      purchase_rate_paise: 38000,
    } as never);
    const documentId = newId();
    const suggestion: AiExtractionItem = {
      documentId,
      bill: {
        supplierName: 'SHREE GANESH TRADERS',
        supplierGstin: '27AAPFU0939F1ZV',
        invoiceNumber: 'SGT/2026/0412',
        date: '2026-06-15',
        lines: [
          {
            description: 'Cement OPC 53 50kg',
            hsn: '2523',
            qty: 20,
            ratePaise: 38000,
            gstRateBp: 2800,
            itemId: String(cement['id']),
          },
          {
            description: 'Delivery charges',
            hsn: null,
            qty: 1,
            ratePaise: 50000,
            gstRateBp: 1800,
            itemId: null,
          },
        ],
        totalPaise: 1031800,
      },
      supplierPartyId: String(supplier['id']),
      fieldConfidence: { supplierName: 0.8, totalPaise: 0.9 },
      checks: { engineTotalPaise: 1031800, totalsAgree: true, gstinValid: true, dateSane: true },
      attachment: {
        fileName: 'bill.jpg',
        mime: 'image/jpeg',
        sizeBytes: 1234,
        sha256: 'ab'.repeat(32),
        storagePath: 'opfs:' + 'ab'.repeat(32),
      },
      sources: ['rules'],
      model: null,
    };
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'ai_extraction',
      payload: { fileName: 'bill.jpg' },
      suggestion,
      schema: aiExtractionItem,
      source: 'rules',
      confidence: 0.85,
    });
    expect(await new DocumentFlowRepo(d).load(ctx, documentId)).toBeNull();

    // an AI actor may not accept it
    await expect(applyReviewItem(d, { ...ctx, actor: 'ai:local-llama' }, item)).rejects.toThrow(
      /cannot accept/,
    );

    // the person changes the free line's rate before accepting
    const edited = {
      ...suggestion,
      bill: {
        ...suggestion.bill,
        lines: [suggestion.bill.lines[0]!, { ...suggestion.bill.lines[1]!, ratePaise: 40000 }],
      },
    };
    const accepted = await applyReviewItem(d, ctx, item, edited);
    expect(accepted['status']).toBe('accepted');
    expect(accepted['correction_json']).not.toBeNull();

    const loaded = await new DocumentFlowRepo(d).load(ctx, documentId);
    expect(loaded).not.toBeNull();
    const doc = loaded!.document;
    expect(doc['type']).toBe('purchase_bill');
    expect(doc['status']).toBe('draft');
    expect(doc['party_id']).toBe(supplier['id']);
    expect((doc['metadata_json'] as { supplierInvoiceNo: string }).supplierInvoiceNo).toBe(
      'SGT/2026/0412',
    );
    expect(doc['date']).toBe('2026-06-15');
    expect(loaded!.lines.length).toBe(2);
    expect(loaded!.lines[0]!['item_id']).toBe(cement['id']);
    // 20 x 380 = 7600 + 28% = 9728; 400 + 18% = 472; total 10200
    expect(Number(doc['total_paise'])).toBe(1020000);
    const meta = doc['metadata_json'] as {
      extraction: { billTotalPaise: number; engineTotalPaise: number };
    };
    expect(meta.extraction.billTotalPaise).toBe(1031800);
    expect(meta.extraction.engineTotalPaise).toBe(1020000);
    const files = await new AttachmentRepo(d).forOwner(ctx, 'documents', documentId);
    expect(files.map((f) => f['file_name'])).toEqual(['bill.jpg']);

    // a second scan, turned down, leaves no draft behind
    const other = await createReviewItem({
      db: d,
      ctx,
      kind: 'ai_extraction',
      payload: null,
      suggestion: { ...suggestion, documentId: newId() },
      schema: aiExtractionItem,
      source: 'rules',
    });
    await new ReviewRepo(d).reject(ctx, other['id'], other['version'], 'not ours');
    expect((await new ReviewRepo(d).inbox(ctx, { view: 'open', now: Date.now() })).length).toBe(0);
  });

  it('refuses an accept whose supplier or item has gone, leaving the item pending', async () => {
    const { d, ctx } = await setup(dialect);
    const documentId = newId();
    const suggestion: AiExtractionItem = {
      documentId,
      bill: {
        supplierName: 'X',
        supplierGstin: null,
        invoiceNumber: '1',
        date: '2026-01-01',
        lines: [
          { description: 'A', hsn: null, qty: 1, ratePaise: 100, gstRateBp: 0, itemId: newId() },
        ],
        totalPaise: 100,
      },
      supplierPartyId: null,
      fieldConfidence: {},
      checks: { engineTotalPaise: 100, totalsAgree: true, gstinValid: null, dateSane: true },
      attachment: null,
      sources: ['rules'],
      model: null,
    };
    const item = await createReviewItem({
      db: d,
      ctx,
      kind: 'ai_extraction',
      payload: null,
      suggestion,
      schema: aiExtractionItem,
      source: 'rules',
    });
    await expect(applyReviewItem(d, ctx, item)).rejects.toThrow(/no longer exists/);
    expect((await new ReviewRepo(d).get(ctx, item['id']))?.['status']).toBe('pending');
    expect(await new DocumentFlowRepo(d).load(ctx, documentId)).toBeNull();
  });
});
