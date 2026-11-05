import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  stockEffectOf,
  type DocumentType,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { InsufficientStockError, InventoryRepo } from './inventory';
import { ItemRepo } from './items';
import { PeriodLockRepo } from './period-lock';
import { runReport } from './reports';

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
  lines: [line()],
  ...over,
});
const rows = (dr: DraftDocument) => {
  const r = draftToRows(dr);
  return {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  };
};
const units = (n: number) => BigInt(Math.round(n * 1_000_000));
const micros = (n: number) => Math.round(n * 1_000_000);

describe.each(DIALECTS)('inventory (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let inv: InventoryRepo;
  let partyId: string;
  let a: string; // tracked, 10 on hand, reorder at 4
  let b: string; // tracked, nothing on hand
  let c: string; // does not track stock

  const issue = async (dr: DraftDocument, inventoryEnabled = true) => {
    const saved = await flow.saveDraft(ctx, rows(dr));
    return flow.issueDraft(ctx, saved.document['id'], saved.document['version'], {
      inventoryEnabled,
    });
  };
  const sale = (itemId: string, qty: number, over: Partial<DraftDocument> = {}) =>
    draft({ partyId, lines: [line({ itemId, qtyMicros: units(qty) })], ...over });
  const onHand = async (id: string) => (await inv.onHand(ctx, [id])).get(id) ?? 0;
  const movements = (documentId: string) =>
    new BaseRepo(d, 'stock_movements')
      .list(ctx)
      .then((r) => r.filter((m) => m['document_id'] === documentId));

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    flow = new DocumentFlowRepo(d);
    inv = new InventoryRepo(d);
    partyId = (
      await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Sharma', state_code: '27' })
    )['id'];
    const items = new ItemRepo(d);
    const base = { hsn: '7318', gst_rate_bp: 1800, purchase_rate_paise: 30_000 };
    a = (
      await items.create(ctx, {
        ...base,
        name: 'Bolt',
        sku: 'BOLT',
        barcode: null,
        track_stock: true,
        opening_stock_micros: micros(10),
        min_stock_micros: micros(4),
      })
    )['id'];
    b = (await items.create(ctx, { ...base, name: 'Nut', sku: 'NUT', track_stock: true }))['id'];
    c = (await items.create(ctx, { ...base, name: 'Tape', sku: 'TAPE', track_stock: false }))['id'];
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('opening stock is a movement, so stock on hand is simply the sum of movements', async () => {
    expect(await onHand(a)).toBe(micros(10));
    expect(await onHand(b)).toBe(0);
    const all = await new BaseRepo(d, 'stock_movements').list(ctx);
    const sum = all
      .filter((m) => m['item_id'] === a)
      .reduce((s, m) => s + Number(m['qty_micros']), 0);
    expect(sum).toBe(micros(10));
  });

  describe('documents move stock the way their type says', () => {
    const cases: [DocumentType, number][] = [
      ['tax_invoice', -2],
      ['bill_of_supply', -2],
      ['debit_note', -2],
      ['purchase_return', -2],
      ['credit_note', 2],
      ['purchase_bill', 2],
    ];
    it.each(cases)('%s moves %i units', async (type, delta) => {
      // a fresh tracked item per case so the cases do not disturb each other
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: `Case ${type}`,
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(10),
        })
      )['id'];
      const purchase = type === 'purchase_bill' || type === 'purchase_return';
      const r = await issue(
        draft({
          type,
          partyId,
          lines: [line({ itemId: item, qtyMicros: units(2) })],
          ...(type === 'purchase_bill'
            ? { supplierInvoiceNo: 'S-1', supplierInvoiceDate: '2026-04-30' }
            : {}),
        }),
      );
      expect(purchase || stockEffectOf(type)).toBeTruthy();
      expect(await onHand(item)).toBe(micros(10 + delta));
      const m = await movements(r.document['id']);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ kind: delta < 0 ? 'out' : 'in', qty_micros: micros(delta) });
    });

    it('quotations and proformas move nothing, and neither does an untracked item', async () => {
      const q = await issue(
        draft({ type: 'quotation', partyId, lines: [line({ itemId: a, qtyMicros: units(1) })] }),
      );
      expect(await movements(q.document['id'])).toHaveLength(0);
      const before = await onHand(a);
      const s = await issue(sale(c, 3));
      expect(await movements(s.document['id'])).toHaveLength(0);
      expect(await onHand(a)).toBe(before);
    });

    it('writes nothing when inventory is switched off for the business', async () => {
      const before = await onHand(a);
      const r = await issue(sale(a, 1), false);
      expect(await movements(r.document['id'])).toHaveLength(0);
      expect(await onHand(a)).toBe(before);
    });
  });

  describe('cancelling puts stock back', () => {
    it('a sale and its cancellation net to nothing, and the movements stay on record', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Cancel me',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(5),
        })
      )['id'];
      const r = await issue(sale(item, 3));
      expect(await onHand(item)).toBe(micros(2));
      await flow.cancelDocument(ctx, r.document['id'], r.document['version'], 'Entered in error', {
        date: '2026-05-02',
      });
      expect(await onHand(item)).toBe(micros(5));
      const m = await movements(r.document['id']);
      expect(m).toHaveLength(2);
      expect(m.reduce((s, x) => s + Number(x['qty_micros']), 0)).toBe(0);
    });

    it('cancelling a purchase takes the goods back out, even when that leaves stock negative', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Bought',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
        })
      )['id'];
      const bill = await issue(
        draft({
          type: 'purchase_bill',
          partyId,
          supplierInvoiceNo: 'S-2',
          supplierInvoiceDate: '2026-04-30',
          lines: [line({ itemId: item, qtyMicros: units(4) })],
        }),
      );
      await issue(sale(item, 3));
      await inv.setPolicy(ctx, 'block');
      try {
        await flow.cancelDocument(
          ctx,
          bill.document['id'],
          bill.document['version'],
          'Wrong supplier',
          {
            date: '2026-05-03',
          },
        );
      } finally {
        await inv.setPolicy(ctx, 'allow');
      }
      // a cancellation is never refused: it corrects a mistake, and the books say what happened
      expect(await onHand(item)).toBe(micros(-3));
    });
  });

  describe('delivery challans', () => {
    it('take stock out only when set to, and an invoice made from one does not take it out twice', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Challan item',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(10),
        })
      )['id'];
      const plain = await issue(
        draft({
          type: 'delivery_challan',
          partyId,
          lines: [line({ itemId: item, qtyMicros: units(2) })],
        }),
      );
      expect(await movements(plain.document['id'])).toHaveLength(0);
      expect(await onHand(item)).toBe(micros(10));

      const challan = await issue(
        draft({
          type: 'delivery_challan',
          partyId,
          reduceStock: true,
          returnable: true,
          lines: [line({ itemId: item, qtyMicros: units(4) })],
        }),
      );
      expect((await movements(challan.document['id']))[0]).toMatchObject({
        kind: 'out',
        qty_micros: micros(-4),
      });
      expect(await onHand(item)).toBe(micros(6));
      expect(challan.document['metadata_json']).toMatchObject({
        reduceStock: true,
        returnable: true,
      });

      const invoice = await issue(
        draft({
          partyId,
          lines: [line({ itemId: item, qtyMicros: units(4) })],
        }),
        true,
      ).catch((e) => e);
      expect(invoice).not.toBeInstanceOf(Error);
      // not linked to the challan, so it takes its own 4 out
      expect(await onHand(item)).toBe(micros(2));

      const linked = await flow.saveDraft(
        ctx,
        rows(draft({ partyId, lines: [line({ itemId: item, qtyMicros: units(4) })] })),
      );
      await new BaseRepo(d, 'documents').update(
        ctx,
        linked.document['id'],
        { source_document_id: challan.document['id'] },
        linked.document['version'],
      );
      const fresh = await flow.load(ctx, linked.document['id']);
      const done = await flow.issueDraft(ctx, linked.document['id'], fresh!.document['version'], {
        inventoryEnabled: true,
      });
      expect(await movements(done.document['id'])).toHaveLength(0);
      expect(await onHand(item)).toBe(micros(2));
    });
  });

  describe('negative stock policy', () => {
    it('is allow unless the business says otherwise, and only allow or block are accepted', async () => {
      expect(await inv.getPolicy(ctx)).toBe('allow');
      await expect(inv.setPolicy(ctx, 'warn' as never)).rejects.toThrow(/allow or block/);
    });

    it('allow: the sale goes through and the screen is told to warn', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Short',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(2),
        })
      )['id'];
      const check = await inv.checkIssue(ctx, 'tax_invoice', [
        { itemId: item, qtyMicros: micros(5) },
      ]);
      expect(check.policy).toBe('allow');
      expect(check.decision).toMatchObject({ action: 'warn' });
      const r = await issue(sale(item, 5));
      expect(r.document['status']).toBe('issued');
      expect(await onHand(item)).toBe(micros(-3));
    });

    it('block: refuses a sale that would go below zero and leaves everything as it was', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Scarce',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(3),
        })
      )['id'];
      await inv.setPolicy(ctx, 'block');
      try {
        const saved = await flow.saveDraft(ctx, rows(sale(item, 4)));
        const err = await flow
          .issueDraft(ctx, saved.document['id'], saved.document['version'], {
            inventoryEnabled: true,
          })
          .catch((e) => e);
        expect(err).toBeInstanceOf(InsufficientStockError);
        expect((err as InsufficientStockError).shortfalls[0]).toMatchObject({
          itemId: item,
          onHandMicros: micros(3),
          needMicros: micros(4),
          afterMicros: micros(-1),
        });
        // all or nothing: still a draft, no number, no ledger, no movement
        const after = await flow.load(ctx, saved.document['id']);
        expect(after!.document['status']).toBe('draft');
        expect(after!.document['number']).toBeNull();
        expect(await movements(saved.document['id'])).toHaveLength(0);
        expect(await onHand(item)).toBe(micros(3));

        // exactly what is there is fine
        const ok = await issue(sale(item, 3));
        expect(ok.document['status']).toBe('issued');
        expect(await onHand(item)).toBe(0);
      } finally {
        await inv.setPolicy(ctx, 'allow');
      }
    });

    it('block counts every line of an item together, ignores untracked items, and lets purchases in', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Two lines',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(5),
        })
      )['id'];
      await inv.setPolicy(ctx, 'block');
      try {
        const two = draft({
          partyId,
          lines: [
            line({ itemId: item, qtyMicros: units(3) }),
            line({ itemId: item, qtyMicros: units(3) }),
            line({ itemId: c, qtyMicros: units(99) }),
          ],
        });
        await expect(issue(two)).rejects.toBeInstanceOf(InsufficientStockError);
        const buy = await issue(
          draft({
            type: 'purchase_bill',
            partyId,
            supplierInvoiceNo: 'S-3',
            supplierInvoiceDate: '2026-04-30',
            lines: [line({ itemId: item, qtyMicros: units(50) })],
          }),
        );
        expect(buy.document['status']).toBe('issued');
      } finally {
        await inv.setPolicy(ctx, 'allow');
      }
    });

    it('is per business: another business is not affected', async () => {
      await inv.setPolicy(ctx, 'block');
      try {
        const other = await tenant(d);
        expect(await inv.getPolicy(other)).toBe('allow');
      } finally {
        await inv.setPolicy(ctx, 'allow');
      }
    });
  });

  describe('manual adjustments', () => {
    it('adds and removes stock with a reason, one movement per item, and audits each', async () => {
      const before = await onHand(b);
      const r = await inv.adjust(ctx, {
        date: '2026-05-10',
        reason: 'found',
        note: 'Behind the shelf',
        lines: [{ itemId: b, deltaMicros: micros(7) }],
      });
      expect(r.adjusted[0]).toMatchObject({
        itemId: b,
        beforeMicros: before,
        deltaMicros: micros(7),
        afterMicros: before + micros(7),
      });
      expect(await onHand(b)).toBe(before + micros(7));
      const m = (await inv.movementsOf(ctx, b))[0]!;
      expect(m).toMatchObject({
        kind: 'adjust',
        qtyMicros: micros(7),
        note: 'found: Behind the shelf',
        documentId: null,
      });
      const audit = await new AuditRepo(d).forRow(ctx, 'stock_movements', m.id);
      expect(audit.length).toBeGreaterThan(0);

      await inv.adjust(ctx, {
        date: '2026-05-11',
        reason: 'damage',
        lines: [{ itemId: b, deltaMicros: micros(-2) }],
      });
      expect(await onHand(b)).toBe(before + micros(5));
    });

    it('refuses a bad entry whole: no reason, a zero line, a duplicate, an untracked or unknown item', async () => {
      const before = await onHand(a);
      const base = { date: '2026-05-10', reason: 'count' };
      await expect(
        inv.adjust(ctx, { ...base, reason: 'whim', lines: [{ itemId: a, deltaMicros: 1 }] }),
      ).rejects.toThrow(/reason/);
      await expect(inv.adjust(ctx, { ...base, lines: [] })).rejects.toThrow(/at least one/);
      await expect(
        inv.adjust(ctx, { ...base, lines: [{ itemId: a, deltaMicros: 0 }] }),
      ).rejects.toThrow(/quantity/);
      await expect(
        inv.adjust(ctx, {
          ...base,
          lines: [
            { itemId: a, deltaMicros: 1 },
            { itemId: a, deltaMicros: 2 },
          ],
        }),
      ).rejects.toThrow(/twice/);
      await expect(
        inv.adjust(ctx, { ...base, lines: [{ itemId: c, deltaMicros: 1 }] }),
      ).rejects.toThrow(/does not track/);
      await expect(
        inv.adjust(ctx, {
          ...base,
          lines: [
            { itemId: a, deltaMicros: micros(1) },
            { itemId: crypto.randomUUID(), deltaMicros: 1 },
          ],
        }),
      ).rejects.toThrow();
      // the good line before the bad one was not kept
      expect(await onHand(a)).toBe(before);
    });

    it('cannot be dated inside a locked period', async () => {
      await new PeriodLockRepo(d).set(ctx, '2026-03-31');
      try {
        await expect(
          inv.adjust(ctx, {
            date: '2026-03-15',
            reason: 'correction',
            lines: [{ itemId: a, deltaMicros: 1 }],
          }),
        ).rejects.toThrow(/locked|closed/i);
      } finally {
        await new PeriodLockRepo(d).set(ctx, null, 'test cleanup').catch(() => undefined);
      }
    });
  });

  describe('physical counts', () => {
    it('book the difference between the count and the movements, and leave matching items alone', async () => {
      const item = (
        await new ItemRepo(d).create(ctx, {
          name: 'Counted',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(10),
        })
      )['id'];
      const same = (
        await new ItemRepo(d).create(ctx, {
          name: 'Same',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          opening_stock_micros: micros(6),
        })
      )['id'];
      await issue(sale(item, 3)); // movements now say 7
      const r = await inv.applyCount(ctx, {
        date: '2026-05-12',
        note: 'Monthly count',
        counts: [
          { itemId: item, countedMicros: micros(6) },
          { itemId: same, countedMicros: micros(6) },
        ],
      });
      expect(r.adjusted).toHaveLength(1);
      expect(r.adjusted[0]).toMatchObject({
        itemId: item,
        beforeMicros: micros(7),
        deltaMicros: micros(-1),
        afterMicros: micros(6),
      });
      expect(await onHand(item)).toBe(micros(6));
      expect(await onHand(same)).toBe(micros(6));
      expect((await inv.movementsOf(ctx, item)).find((m) => m.kind === 'adjust')!.note).toBe(
        'count: Monthly count',
      );
    });

    it('refuses a negative count', async () => {
      await expect(
        inv.applyCount(ctx, { date: '2026-05-12', counts: [{ itemId: a, countedMicros: -1 }] }),
      ).rejects.toThrow(/negative/);
    });

    it('matches sheet rows to items by SKU, barcode or name, and says what it could not match', async () => {
      await new ItemRepo(d).create(ctx, {
        name: 'Twin',
        hsn: '7318',
        gst_rate_bp: 1800,
        track_stock: true,
      });
      await new ItemRepo(d).create(ctx, {
        name: 'Twin',
        hsn: '7318',
        gst_rate_bp: 1800,
        track_stock: true,
      });
      const m = await inv.matchCount(ctx, [
        { by: 'sku', key: 'bolt', countedMicros: 1, line: 2 },
        { by: 'sku', key: 'NOPE', countedMicros: 1, line: 3 },
        { by: 'sku', key: 'TAPE', countedMicros: 1, line: 4 },
        { by: 'name', key: 'twin', countedMicros: 1, line: 5 },
        { by: 'name', key: 'Nut', countedMicros: 1, line: 6 },
      ]);
      expect(m.matched.map((x) => x.name)).toEqual(['Bolt', 'Nut']);
      expect(m.matched[0]!.onHandMicros).toBe(await onHand(a));
      expect(m.missing.map((x) => x.line)).toEqual([3]);
      expect(m.untracked.map((x) => x.line)).toEqual([4]);
      expect(m.ambiguous.map((x) => x.line)).toEqual([5]);
    });
  });

  it('low stock lists items below their reorder level, and an adjustment clears them', async () => {
    const item = (
      await new ItemRepo(d).create(ctx, {
        name: 'Runs low',
        hsn: '7318',
        gst_rate_bp: 1800,
        track_stock: true,
        opening_stock_micros: micros(5),
        min_stock_micros: micros(8),
      })
    )['id'];
    const none = (
      await new ItemRepo(d).create(ctx, {
        name: 'No level',
        hsn: '7318',
        gst_rate_bp: 1800,
        track_stock: true,
      })
    )['id'];
    const low = await inv.lowStock(ctx);
    expect(low.map((x) => x.itemId)).toContain(item);
    expect(low.map((x) => x.itemId)).not.toContain(none); // a level of zero means none is set
    expect(low.find((x) => x.itemId === item)).toMatchObject({
      onHandMicros: micros(5),
      minMicros: micros(8),
    });
    await inv.adjust(ctx, {
      date: '2026-05-13',
      reason: 'found',
      lines: [{ itemId: item, deltaMicros: micros(3) }],
    });
    expect((await inv.lowStock(ctx)).map((x) => x.itemId)).not.toContain(item);
  });

  it('is scoped to the business: another business sees none of this stock', async () => {
    const other = await tenant(d);
    expect((await inv.onHand(other)).size).toBe(0);
    expect(await inv.lowStock(other)).toEqual([]);
  });
});

describe.each(DIALECTS)('stock on the seeded book (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ({ ctx } = await seedDemo(d, { documents: 400, parties: 30, items: 60 }));
  }, 120_000);
  afterAll(async () => {
    await d.close();
  });

  it('stock on hand equals the sum of movements, and equals opening stock plus what the documents moved', async () => {
    const inv = new InventoryRepo(d);
    const onHand = await inv.onHand(ctx);
    const items = await new BaseRepo(d, 'items').list(ctx);
    const movements = await new BaseRepo(d, 'stock_movements').list(ctx);
    const docs = await new BaseRepo(d, 'documents').list(ctx);
    const doc = new Map(docs.map((x) => [x['id'], x]));
    const lines = await new BaseRepo(d, 'document_lines').list(ctx);

    // expected, from the documents alone
    const expected = new Map<string, number>();
    const add = (id: string, q: number) => expected.set(id, (expected.get(id) ?? 0) + q);
    for (const m of movements.filter((x) => !x['document_id']))
      add(m['item_id'], Number(m['qty_micros'])); // opening
    for (const l of lines) {
      const dc = doc.get(l['document_id']);
      if (!dc || dc['status'] !== 'issued' || !l['item_id']) continue;
      const effect = stockEffectOf(dc['type'] as DocumentType);
      if (!effect) continue;
      const item = items.find((i) => i['id'] === l['item_id'])!;
      if (!item['track_stock']) continue;
      add(l['item_id'], effect === 'out' ? -Number(l['qty_micros']) : Number(l['qty_micros']));
    }

    let checked = 0;
    for (const item of items.filter((i) => i['track_stock'])) {
      const sum = movements
        .filter((m) => m['item_id'] === item['id'])
        .reduce((s, m) => s + Number(m['qty_micros']), 0);
      expect(onHand.get(item['id']) ?? 0, `${item['name']} on hand vs movements`).toBe(sum);
      expect(expected.get(item['id']) ?? 0, `${item['name']} movements vs documents`).toBe(sum);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    // untracked items never have movements
    for (const item of items.filter((i) => !i['track_stock'])) {
      expect(movements.some((m) => m['item_id'] === item['id'])).toBe(false);
    }
  });

  it('the stock summary report is the same stock, valued at the purchase price', async () => {
    const inv = new InventoryRepo(d);
    const onHand = await inv.onHand(ctx);
    const items = await new BaseRepo(d, 'items').list(ctx);
    const r = await runReport(d, ctx, 'stock_summary', {
      from: '2024-04-01',
      to: '2026-03-31',
      today: '2026-03-31',
    });
    expect(r.rows.length).toBe(items.filter((i) => i['track_stock']).length);
    let value = 0;
    for (const row of r.rows) {
      expect(Number(row['closing']), String(row['item'])).toBe(onHand.get(String(row['id'])) ?? 0);
      const rate = Number(items.find((i) => i['id'] === row['id'])!['purchase_rate_paise']);
      expect(Number(row['value'])).toBe(Math.round((Number(row['closing']) * rate) / 1_000_000));
      value += Number(row['value']);
    }
    expect(r.totals['value']).toBe(value);
    // movements to the day equal the summary's opening + in - out
    for (const row of r.rows)
      expect(Number(row['closing'])).toBe(
        Number(row['opening']) + Number(row['in']) - Number(row['out']),
      );
  });

  it('seeded reorder levels make some items low', async () => {
    const low = await new InventoryRepo(d).lowStock(ctx);
    expect(low.length).toBeGreaterThan(0);
    for (const x of low) expect(x.onHandMicros).toBeLessThan(x.minMicros);
  });
});
