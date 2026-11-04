import {
  buildDocument,
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { BaseRepo, RuleError, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { ItemRepo } from './items';
import { consistencyValidator } from './line-math';

async function tenant(d: Database, over: Record<string, unknown> = {}): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Demo',
    state_code: '27',
    ...over,
  });
  return { ...base, businessId: biz['id'] };
}

let k = 0;
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${++k}`),
  description: 'Widget',
  qtyMicros: 2_000_000n,
  ratePaise: 50_000n,
  gstRateBp: 1800,
  ...over,
});
const draft = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
  lines: [line()],
  ...over,
});
const rows = (d: DraftDocument) => {
  const r = draftToRows(d);
  return {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  };
};

describe.each(DIALECTS)('document flow (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let partyId: string;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    flow = new DocumentFlowRepo(d);
    partyId = (
      await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Sharma', state_code: '27' })
    )['id'];
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  const save = (dr: DraftDocument) => flow.saveDraft(ctx, rows(dr));
  const entries = async (documentId: string) =>
    (await new BaseRepo(d, 'ledger_entries').list(ctx)).filter(
      (e) => e['document_id'] === documentId,
    );

  describe('saving drafts', () => {
    it('creates a draft with its lines and loads it back', async () => {
      const saved = await save(
        draft({ partyId, partyName: 'Sharma', lines: [line(), line({ ratePaise: 1_000n })] }),
      );
      expect(saved.changed).toBe(true);
      expect(saved.document).toMatchObject({
        status: 'draft',
        number: null,
        party_id: partyId,
        total_paise: 120_400,
        round_off_paise: 40,
      });
      expect(saved.lines.map((l) => l['line_no'])).toEqual([1, 2]);
      const loaded = (await flow.load(ctx, saved.document['id']))!;
      expect(loaded.lines).toHaveLength(2);
      expect(loaded.lines[0]).toMatchObject({
        gst_rate_bp: 1800,
        price_includes_tax: false,
        taxability: 'taxable',
      });
    });

    it('writes nothing when nothing changed, and only the changed line when one cell changes', async () => {
      const dr = draft({ lines: [line(), line({ ratePaise: 7_000n })] });
      const first = await save(dr);
      const id = first.document['id'] as string;
      const audit = new AuditRepo(d);
      const before = (await audit.recent(ctx, 5000)).length;

      const again = await flow.saveDraft(ctx, {
        ...rows(dr),
        id,
        version: first.document['version'],
      });
      expect(again.changed).toBe(false);
      expect((await audit.recent(ctx, 5000)).length).toBe(before);

      const edited = draft({ lines: [dr.lines[0]!, { ...dr.lines[1]!, ratePaise: 8_000n }] });
      const second = await flow.saveDraft(ctx, {
        ...rows(edited),
        id,
        version: again.document['version'],
      });
      expect(second.changed).toBe(true);
      // the header (totals changed) and one line, not every line
      expect((await audit.recent(ctx, 5000)).length).toBe(before + 2);
      expect(second.lines[0]!['version']).toBe(1);
      expect(second.lines[1]!['version']).toBe(2);
    });

    it('drops lines that were removed and keeps numbering gapless', async () => {
      const three = draft({ lines: [line(), line({ ratePaise: 1n }), line({ ratePaise: 2n })] });
      const a = await save(three);
      const b = await flow.saveDraft(ctx, {
        ...rows({ ...three, lines: [three.lines[0]!] }),
        id: a.document['id'],
        version: a.document['version'],
      });
      expect(b.lines).toHaveLength(1);
      expect((await flow.load(ctx, a.document['id']))!.lines).toHaveLength(1);
    });

    it('rejects stale versions and tampered totals', async () => {
      const a = await save(draft());
      await flow.saveDraft(ctx, {
        ...rows(draft({ notes: 'x' })),
        id: a.document['id'],
        version: a.document['version'],
      });
      await expect(
        flow.saveDraft(ctx, {
          ...rows(draft({ notes: 'y' })),
          id: a.document['id'],
          version: a.document['version'],
        }),
      ).rejects.toThrow();
      const r = rows(draft());
      await expect(
        flow.saveDraft(ctx, { doc: { ...r.doc, total_paise: 1 }, lines: r.lines }),
      ).rejects.toThrow(/totals rejected/);
      await expect(
        flow.saveDraft(ctx, { doc: r.doc, lines: [{ ...r.lines[0]!, cgst_paise: 5 }] }),
      ).rejects.toThrow(/rejected/);
    });

    it('lists drafts newest first and discards one', async () => {
      const list = await flow.listDrafts(ctx);
      expect(list.length).toBeGreaterThan(2);
      expect(list.every((x) => x['status'] === 'draft')).toBe(true);
      const mine = await save(draft({ notes: 'to discard' }));
      await flow.discardDraft(ctx, mine['document']['id'], mine['document']['version']);
      expect(await flow.load(ctx, mine['document']['id'])).toBeNull();
    });
  });

  describe('the repository accepts everything the editor builds', () => {
    it('never rejects a save from the editor, whatever the draft', async () => {
      const arbLine = fc.record({
        qty: fc.integer({ min: 1, max: 100_000_000 }),
        rate: fc.integer({ min: 1, max: 10_000_000 }),
        gst: fc.constantFrom(0, 100, 500, 1200, 1800, 2800),
        mode: fc.constantFrom('none', 'percent', 'per_unit'),
        disc: fc.integer({ min: 0, max: 3000 }),
        inclusive: fc.boolean(),
        cess: fc.constantFrom(0, 100, 1200),
        tax: fc.constantFrom('taxable', 'taxable', 'exempt', 'nil_rated'),
      });
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbLine, { minLength: 1, maxLength: 6 }),
          fc.constantFrom('27', '29', '07', '96'),
          fc.boolean(),
          fc.boolean(),
          fc.option(fc.integer({ min: 1, max: 2500 }), { nil: undefined }),
          async (ls, pos, rcm, roundOff, invDisc) => {
            const dr = draft({
              placeOfSupply: pos,
              export: pos === '96',
              lut: pos === '96',
              reverseCharge: rcm,
              roundOff,
              discountMode: ls[0]!.mode as DraftDocument['discountMode'],
              ...(invDisc ? { invoiceDiscount: { mode: 'percent' as const, bp: invDisc } } : {}),
              lines: ls.map((x) =>
                line({
                  qtyMicros: BigInt(x.qty),
                  ratePaise: BigInt(x.rate),
                  gstRateBp: x.gst,
                  discountValue: BigInt(x.disc),
                  inclusive: x.inclusive,
                  cessBp: x.cess,
                  taxability: x.tax as DraftLine['taxability'],
                }),
              ),
            });
            const r = rows(dr);
            expect(consistencyValidator(r.doc, r.lines)).toEqual([]);
            await flow.saveDraft(ctx, r);
          },
        ),
        { numRuns: 25 },
      );
    }, 120_000);
  });

  describe('issuing', () => {
    it('numbers invoices in sequence, per type, with the financial year in the number', async () => {
      const a = await save(draft({ partyId }));
      const b = await save(draft({ partyId }));
      const q = await save(draft({ type: 'quotation', partyId }));
      const ia = await flow.issueDraft(ctx, a.document['id'], a.document['version']);
      const ib = await flow.issueDraft(ctx, b.document['id'], b.document['version']);
      const iq = await flow.issueDraft(ctx, q.document['id'], q.document['version']);
      expect(ia.document).toMatchObject({ status: 'issued', number: 'INV/26-27/0001' });
      expect(ib.document['number']).toBe('INV/26-27/0002');
      expect(iq.document['number']).toBe('QT/26-27/0001');
      expect(ia.document['series_id']).toBeTruthy();
    });

    it('never reuses a number that is already on a document', async () => {
      // history imported with numbers in the same format the series would produce
      await new BaseRepo(d, 'documents').create(ctx, {
        type: 'bill_of_supply',
        status: 'issued',
        number: 'BOS/26-27/0001',
        date: '2026-05-01',
      });
      await new BaseRepo(d, 'documents').create(ctx, {
        type: 'bill_of_supply',
        status: 'issued',
        number: 'BOS/26-27/0002',
        date: '2026-05-01',
      });
      const a = await save(draft({ type: 'bill_of_supply', partyId }));
      const issued = await flow.issueDraft(ctx, a.document['id'], a.document['version']);
      expect(issued.document['number']).toBe('BOS/26-27/0003');
    });

    it('restarts numbering in a new financial year', async () => {
      const old = await save(draft({ date: '2027-03-31' }));
      const next = await save(draft({ date: '2027-04-01' }));
      const io = await flow.issueDraft(ctx, old.document['id'], old.document['version']);
      const inx = await flow.issueDraft(ctx, next.document['id'], next.document['version']);
      expect(io.document['number']).toMatch(/^INV\/26-27\/\d{4}$/);
      expect(inx.document['number']).toBe('INV/27-28/0001');
    });

    it('refuses to issue twice, a stale version, or a blank document', async () => {
      const a = await save(draft());
      const issued = await flow.issueDraft(ctx, a.document['id'], a.document['version']);
      await expect(
        flow.issueDraft(ctx, a.document['id'], issued.document['version']),
      ).rejects.toThrow(/only draft/);
      const b = await save(draft());
      await expect(flow.issueDraft(ctx, b.document['id'], 99)).rejects.toThrow();
      // a stale attempt must not burn a number
      const c = await save(draft());
      const ic = await flow.issueDraft(ctx, c.document['id'], c.document['version']);
      expect(Number(/(\d+)$/.exec(ic.document['number'])![1])).toBe(
        Number(/(\d+)$/.exec(issued.document['number'])![1]) + 1,
      );
      const blank = await flow
        .saveDraft(ctx, { doc: rows(draft()).doc, lines: [] })
        .catch(() => null);
      if (blank)
        await expect(
          flow.issueDraft(ctx, blank.document['id'], blank.document['version']),
        ).rejects.toThrow(/blank/);
    });

    it('posts balanced ledger entries that match the document, with the party on the receivable', async () => {
      const a = await save(
        draft({
          partyId,
          placeOfSupply: '29',
          lines: [line(), line({ ratePaise: 33_333n, gstRateBp: 500 })],
        }),
      );
      const { document } = await flow.issueDraft(ctx, a.document['id'], a.document['version']);
      const e = await entries(document['id']);
      const dr = e.reduce((s, x) => s + Number(x['debit_paise']), 0);
      const cr = e.reduce((s, x) => s + Number(x['credit_paise']), 0);
      expect(dr).toBe(cr);
      expect(dr).toBeGreaterThan(0);
      const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
      const byId = new Map(accounts.map((x) => [x['id'], x['code']]));
      const receivable = e.find((x) => byId.get(x['account_id']) === '1200')!;
      expect(receivable).toMatchObject({ debit_paise: document['total_paise'], party_id: partyId });
      expect(
        e
          .filter((x) => byId.get(x['account_id']) === '2100')
          .reduce((s, x) => s + Number(x['credit_paise']), 0),
      ).toBe(Number(document['total_igst_paise']));
    });

    it('posts TCS and round-off to accounts that older businesses did not have', async () => {
      const a = await save(
        draft({
          partyId,
          tcs: { rateBp: 100, cumulativeBeforePaise: 600_000_000n },
          date: '2024-06-01',
          lines: [line({ ratePaise: 12_345n })],
        }),
      );
      const { document } = await flow.issueDraft(ctx, a.document['id'], a.document['version']);
      const accounts = await new BaseRepo(d, 'ledger_accounts').list(ctx);
      expect(accounts.map((x) => x['code'])).toEqual(expect.arrayContaining(['2200', '5200']));
      const e = await entries(document['id']);
      expect(e.reduce((s, x) => s + Number(x['debit_paise']), 0)).toBe(
        e.reduce((s, x) => s + Number(x['credit_paise']), 0),
      );
    });

    it('does not post quotations, proformas or challans', async () => {
      const q = await save(draft({ type: 'proforma', partyId }));
      const { document } = await flow.issueDraft(ctx, q.document['id'], q.document['version']);
      expect(await entries(document['id'])).toHaveLength(0);
    });

    it('moves stock out for a sale and in for a purchase, only for tracked items', async () => {
      const items = new ItemRepo(d);
      const tracked = await items.create(ctx, {
        name: 'Tracked bolt',
        track_stock: true,
        hsn: '7318',
        gst_rate_bp: 1800,
      });
      const plain = await items.create(ctx, {
        name: 'Untracked tape',
        hsn: '3919',
        gst_rate_bp: 1800,
      });
      const sale = await save(
        draft({
          partyId,
          lines: [
            line({ itemId: tracked['id'], qtyMicros: 3_000_000n }),
            line({ itemId: plain['id'] }),
          ],
        }),
      );
      const issued = await flow.issueDraft(ctx, sale.document['id'], sale.document['version'], {
        inventoryEnabled: true,
      });
      const moves = (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
        (m) => m['document_id'] === issued.document['id'],
      );
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({
        item_id: tracked['id'],
        kind: 'out',
        qty_micros: -3_000_000,
      });

      const buy = await save(
        draft({
          type: 'purchase_bill',
          partyId,
          supplierInvoiceNo: 'S-1',
          supplierInvoiceDate: '2026-04-30',
          lines: [line({ itemId: tracked['id'], qtyMicros: 10_000_000n })],
        }),
      );
      const bought = await flow.issueDraft(ctx, buy.document['id'], buy.document['version'], {
        inventoryEnabled: true,
      });
      const inMoves = (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
        (m) => m['document_id'] === bought.document['id'],
      );
      expect(inMoves[0]).toMatchObject({ kind: 'in', qty_micros: 10_000_000 });

      const off = await save(draft({ partyId, lines: [line({ itemId: tracked['id'] })] }));
      const noStock = await flow.issueDraft(ctx, off.document['id'], off.document['version']);
      expect(
        (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
          (m) => m['document_id'] === noStock.document['id'],
        ),
      ).toHaveLength(0);
    });

    it('creates a linked self-invoice for a reverse-charge purchase bill, and posts the bill once', async () => {
      const bill = await save(
        draft({
          type: 'purchase_bill',
          partyId,
          reverseCharge: true,
          supplierInvoiceNo: 'S-9',
          supplierInvoiceDate: '2026-04-30',
        }),
      );
      const r = await flow.issueDraft(ctx, bill.document['id'], bill.document['version']);
      expect(r.selfInvoice).toMatchObject({
        type: 'rcm_self_invoice',
        status: 'issued',
        source_document_id: bill.document['id'],
        total_paise: r.document['total_paise'],
      });
      expect(r.selfInvoice!['number']).toMatch(/^RCM\/26-27\/\d{4}$/);
      expect((await flow.load(ctx, r.selfInvoice!['id']))!.lines).toHaveLength(1);
      expect(await entries(r.selfInvoice!['id'])).toHaveLength(0);
      expect((await entries(r.document['id'])).length).toBeGreaterThan(0);
      const plain = await save(
        draft({
          type: 'purchase_bill',
          partyId,
          supplierInvoiceNo: 'S-10',
          supplierInvoiceDate: '2026-04-30',
        }),
      );
      expect(
        (await flow.issueDraft(ctx, plain.document['id'], plain.document['version'])).selfInvoice,
      ).toBeNull();
    });
  });

  it('keeps totals equal to the engine for what it stored', async () => {
    const dr = draft({
      partyId,
      placeOfSupply: '29',
      discountMode: 'percent',
      invoiceDiscount: { mode: 'percent', bp: 300 },
      lines: [
        line({ discountValue: 1250n }),
        line({ inclusive: true, ratePaise: 11_800n, gstRateBp: 1800 }),
      ],
    });
    const saved = await save(dr);
    expect(saved.document['total_paise']).toBe(buildDocument(dr).money.total_paise);
  });
});

describe.each(DIALECTS)('composition businesses (%s)', (dialect) => {
  it('cannot create a tax invoice but can issue a bill of supply', async () => {
    const d = await openTestDb(dialect);
    try {
      const ctx = await tenant(d, { scheme: 'composition' });
      const flow = new DocumentFlowRepo(d);
      // a tax invoice cannot even be started (CGST s.10), and nothing is written
      await expect(flow.saveDraft(ctx, rows(draft({ composition: true })))).rejects.toBeInstanceOf(
        RuleError,
      );
      expect(await flow.listDrafts(ctx)).toHaveLength(0);
      const bos = await flow.saveDraft(
        ctx,
        rows(draft({ type: 'bill_of_supply', composition: true })),
      );
      const issued = await flow.issueDraft(ctx, bos.document['id'], bos.document['version']);
      expect(issued.document).toMatchObject({ status: 'issued', total_cgst_paise: 0 });
    } finally {
      await d.close();
    }
  }, 60_000);
});
