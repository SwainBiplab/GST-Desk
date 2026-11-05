import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  monthPeriod,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { BaseRepo, ConflictError, RuleError, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { GstrRepo } from './gstr';
import { ItemRepo } from './items';
import { NumberingRepo } from './numbering';
import { PeriodLockRepo, PeriodLockedError } from './period-lock';

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
const rows = (dr: DraftDocument) => {
  const r = draftToRows(dr);
  return {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  };
};

describe.each(DIALECTS)('numbering, cancellation and audit (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let series: NumberingRepo;
  let lock: PeriodLockRepo;
  let partyId: string;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    flow = new DocumentFlowRepo(d);
    series = new NumberingRepo(d);
    lock = new PeriodLockRepo(d);
    partyId = (
      await new PartyRepo(d).create(ctx, { type: 'customer', name: 'Sharma', state_code: '27' })
    )['id'];
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  /** Save and issue a document of the given draft. */
  const issue = async (dr: DraftDocument, opts = {}, c: Ctx = ctx) => {
    const saved = await flow.saveDraft(c, rows(dr));
    return flow.issueDraft(c, saved.document['id'], saved.document['version'], opts);
  };
  const get = async (id: string) => (await flow.load(ctx, id))!.document;
  const ledgerNet = async (documentId: string) => {
    const all = (await new BaseRepo(d, 'ledger_entries').list(ctx)).filter(
      (e) => e['document_id'] === documentId,
    );
    const net = new Map<string, number>();
    for (const e of all)
      net.set(
        e['account_id'],
        (net.get(e['account_id']) ?? 0) + Number(e['debit_paise']) - Number(e['credit_paise']),
      );
    return { all, net };
  };

  describe('series', () => {
    it('numbers from the type default, and from a series named at issue', async () => {
      const a = await issue(draft({ partyId, date: '2026-05-02' }));
      expect(a.document['number']).toMatch(/^INV\/26-27\/0001$/);

      const ws = await series.createSeries(ctx, {
        documentType: 'tax_invoice',
        name: 'Wholesale',
        prefix: 'WS/{FY}/',
        padding: 3,
        reset: 'fy',
      });
      const b = await issue(draft({ partyId, date: '2026-05-02' }), { seriesKey: ws.key });
      expect(b.document['number']).toBe('WS/26-27/001');
      // the default is untouched
      const c = await issue(draft({ partyId, date: '2026-05-02' }));
      expect(c.document['number']).toBe('INV/26-27/0002');
    });

    it('uses the shell default series when no series is named', async () => {
      await series.createSeries(ctx, {
        documentType: 'quotation',
        name: 'Quotes',
        prefix: 'QT/{FY}/',
        padding: 4,
        reset: 'fy',
      });
      const retail = await series.createSeries(ctx, {
        documentType: 'quotation',
        name: 'Counter quotes',
        prefix: 'CQ/{FY}/',
        padding: 4,
        reset: 'fy',
        shellDefault: 'shop',
      });
      expect(retail.shellDefault).toBe('shop');
      const shop = await issue(draft({ type: 'quotation', partyId }), { shell: 'shop' });
      expect(shop.document['number']).toBe('CQ/26-27/0001');
      const books = await issue(draft({ type: 'quotation', partyId }), { shell: 'books' });
      expect(books.document['number']).toMatch(/^QT\//);
    });

    it('refuses a series that breaks the GST rules or repeats another series prefix', async () => {
      await expect(
        series.createSeries(ctx, {
          documentType: 'tax_invoice',
          name: 'Bad',
          prefix: 'IN#V',
          padding: 4,
          reset: 'fy',
        }),
      ).rejects.toThrow(/letters, digits/);
      await expect(
        series.createSeries(ctx, {
          documentType: 'tax_invoice',
          name: 'Too long',
          prefix: 'ABCDEFGHIJKL/{FY}/',
          padding: 4,
          reset: 'fy',
        }),
      ).rejects.toThrow(/16 characters|padding/);
      await expect(
        series.createSeries(ctx, {
          documentType: 'tax_invoice',
          name: 'Same prefix',
          prefix: 'WS/{FY}/',
          padding: 4,
          reset: 'fy',
        }),
      ).rejects.toThrow(/numbers could repeat/);
    });

    it('a rename changes future numbers only; issued numbers keep their text', async () => {
      const s = await series.createSeries(ctx, {
        documentType: 'debit_note',
        name: 'Debit',
        prefix: 'DB/{FY}/',
        padding: 4,
        reset: 'fy',
      });
      const first = await issue(draft({ type: 'debit_note', partyId }), { seriesKey: s.key });
      expect(first.document['number']).toBe('DB/26-27/0001');
      await series.updateSeries(ctx, s.key, { prefix: 'DN-{FY}-' });
      const second = await issue(draft({ type: 'debit_note', partyId }), { seriesKey: s.key });
      expect(second.document['number']).toBe('DN-26-27-0002');
      expect((await get(first.document['id']))['number']).toBe('DB/26-27/0001');
    });

    it('restarts at 1 on 1 April, and a back-dated document keeps its own year counter', async () => {
      const s = await series.createSeries(ctx, {
        documentType: 'delivery_challan',
        name: 'Challan',
        prefix: 'CH/{FY}/',
        padding: 4,
        reset: 'fy',
      });
      const on = (date: string) =>
        issue(draft({ type: 'delivery_challan', partyId, date }), { seriesKey: s.key });
      expect((await on('2026-03-30')).document['number']).toBe('CH/25-26/0001');
      expect((await on('2026-03-31')).document['number']).toBe('CH/25-26/0002');
      expect((await on('2026-04-01')).document['number']).toBe('CH/26-27/0001');
      // back-dated into the old year: continues that year, does not disturb the new one
      expect((await on('2026-03-15')).document['number']).toBe('CH/25-26/0003');
      expect((await on('2026-04-02')).document['number']).toBe('CH/26-27/0002');
    });

    it('a series with issued numbers cannot be removed; an unused one can', async () => {
      const unused = await series.createSeries(ctx, {
        documentType: 'proforma',
        name: 'Spare',
        prefix: 'SP/',
        padding: 4,
        reset: 'never',
      });
      const other = await series.createSeries(ctx, {
        documentType: 'proforma',
        name: 'Other',
        prefix: 'OT/',
        padding: 4,
        reset: 'never',
      });
      await issue(draft({ type: 'proforma', partyId }), { seriesKey: other.key });
      await expect(series.removeSeries(ctx, other.key)).rejects.toThrow(/issued/);
      await series.removeSeries(ctx, unused.key);
      expect((await series.listSeries(ctx, 'proforma')).map((s) => s.name)).toEqual(['Other']);
    });

    it('previews the next number', async () => {
      const s = (await series.listSeries(ctx, 'tax_invoice')).find((x) => x.isDefault)!;
      expect(await series.preview(ctx, s.key, '2026-05-20')).toMatch(/^INV\/26-27\/\d{4}$/);
    });

    it('issues 1,000 documents from 8 workers on one database with no gaps and no duplicates', async () => {
      const own = await tenant(d);
      const ids: { id: string; version: number }[] = [];
      const maker = new DocumentFlowRepo(d);
      for (let i = 0; i < 1000; i++) {
        const saved = await maker.saveDraft(
          own,
          rows(draft({ date: '2026-06-01', lines: [line({ ratePaise: BigInt(100 + i) })] })),
        );
        ids.push({ id: saved.document['id'], version: saved.document['version'] });
      }
      const queue = [...ids];
      const workers = Array.from({ length: 8 }, () => new DocumentFlowRepo(d));
      const numbers: string[] = [];
      await Promise.all(
        workers.map(async (w) => {
          for (;;) {
            const next = queue.shift();
            if (!next) return;
            const r = await w.issueDraft(own, next.id, next.version);
            numbers.push(String(r.document['number']));
          }
        }),
      );
      expect(numbers).toHaveLength(1000);
      expect(new Set(numbers).size).toBe(1000);
      const serials = numbers.map((n) => Number(n.split('/').pop())).sort((a, b) => a - b);
      expect(serials[0]).toBe(1);
      expect(serials[999]).toBe(1000);
      expect(serials.every((n, i) => n === i + 1)).toBe(true);
    }, 280_000);
  });

  describe('cancelling', () => {
    it('keeps the number, leaves the totals, reverses ledger and stock, and warns about payments', async () => {
      const item = await new ItemRepo(d).create(ctx, {
        name: 'Tracked nut',
        track_stock: true,
        hsn: '7318',
        gst_rate_bp: 1800,
      });
      const r = await issue(
        draft({
          partyId,
          date: '2026-05-10',
          lines: [line({ itemId: item['id'], qtyMicros: 4_000_000n })],
        }),
        { inventoryEnabled: true },
      );
      const id = r.document['id'] as string;
      // a payment applied to it
      const pay = await new BaseRepo(d, 'payments').create(ctx, {
        date: '2026-05-11',
        direction: 'received',
        mode: 'cash',
        party_id: partyId,
        amount_paise: 10_000,
        status: 'cleared',
      });
      await new BaseRepo(d, 'payment_allocations').create(ctx, {
        payment_id: pay['id'],
        document_id: id,
        amount_paise: 10_000,
        kind: 'payment',
      });
      const before = await flow.fyTotals(ctx, partyId, '2026-04-01', '2027-03-31');

      const out = await flow.cancelDocument(ctx, id, r.document['version'], 'Wrong customer', {
        date: '2026-05-12',
      });
      expect(out.document).toMatchObject({
        status: 'cancelled',
        number: r.document['number'],
        cancel_reason: 'Wrong customer',
      });
      expect(out.unallocated).toEqual([
        { paymentId: pay['id'], documentId: id, amountPaise: 10_000 },
      ]);

      const { all, net } = await ledgerNet(id);
      expect(all.length).toBeGreaterThan(0);
      expect([...net.values()].every((v) => v === 0)).toBe(true);

      const moves = (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
        (m) => m['document_id'] === id,
      );
      expect(moves.reduce((n, m) => n + Number(m['qty_micros']), 0)).toBe(0);

      const after = await flow.fyTotals(ctx, partyId, '2026-04-01', '2027-03-31');
      expect(after.salesPaise).toBeLessThan(before.salesPaise);
      const live = (await new BaseRepo(d, 'payment_allocations').list(ctx)).filter(
        (a) => a['document_id'] === id,
      );
      expect(live).toHaveLength(0);
    });

    it('needs a reason, and only an issued document can be cancelled, once', async () => {
      const r = await issue(draft({ partyId }));
      await expect(flow.cancelDocument(ctx, r.document['id'], 1, '   ')).rejects.toThrow(/why/);
      const draftOnly = await flow.saveDraft(ctx, rows(draft({ partyId })));
      await expect(flow.cancelDocument(ctx, draftOnly.document['id'], 1, 'oops')).rejects.toThrow(
        /discard a draft/,
      );
      const done = await flow.cancelDocument(ctx, r.document['id'], r.document['version'], 'Dup');
      await expect(
        flow.cancelDocument(ctx, r.document['id'], done.document['version'], 'again'),
      ).rejects.toThrow(/already cancelled/);
    });

    it('refuses to cancel a document whose period has been filed, and points at a credit note', async () => {
      const r = await issue(draft({ partyId, date: '2026-03-12' }));
      const gstr = new GstrRepo(d);
      const p = monthPeriod('27AAPFU0939F1ZV', 2026, 3);
      await gstr.markFiled(ctx, 'gstr1', p, { arn: 'AA270326123456Z', filedOn: '2026-04-09' });
      await expect(
        flow.cancelDocument(ctx, r.document['id'], r.document['version'], 'wrong party'),
      ).rejects.toThrow(/filed .*credit note/);
      // a document in an unfiled month still cancels
      const r2 = await issue(draft({ partyId, date: '2026-04-02' }));
      await flow.cancelDocument(ctx, r2.document['id'], r2.document['version'], 'ok');
    });

    it('refuses a document with an IRN until e-invoice cancellation exists', async () => {
      const r = await issue(draft({ partyId }));
      await new BaseRepo(d, 'documents').update(
        ctx,
        r.document['id'],
        { irn: 'a'.repeat(64) },
        r.document['version'],
      );
      await expect(
        flow.cancelDocument(ctx, r.document['id'], r.document['version'] + 1, 'x'),
      ).rejects.toThrow(/e-invoice/);
    });

    it('is one transaction: a failure part-way leaves the document issued and the ledger as it was', async () => {
      const r = await issue(draft({ partyId, date: '2026-05-14' }));
      const id = r.document['id'] as string;
      const before = (await ledgerNet(id)).all.length;
      const real = (flow as any).reverseStockIn;
      (flow as any).reverseStockIn = () => {
        throw new Error('disk full');
      };
      try {
        await expect(
          flow.cancelDocument(ctx, id, r.document['version'], 'will fail'),
        ).rejects.toThrow('disk full');
      } finally {
        (flow as any).reverseStockIn = real;
      }
      expect((await get(id))['status']).toBe('issued');
      expect((await ledgerNet(id)).all).toHaveLength(before);
    });

    it('a stale version is a conflict and changes nothing', async () => {
      const r = await issue(draft({ partyId }));
      await expect(flow.cancelDocument(ctx, r.document['id'], 99, 'x')).rejects.toThrow(
        ConflictError,
      );
      expect((await get(r.document['id']))['status']).toBe('issued');
    });

    it('cancelling a reverse-charge bill cancels its self-invoice too', async () => {
      const bill = await issue(
        draft({
          type: 'purchase_bill',
          partyId,
          reverseCharge: true,
          supplierInvoiceNo: 'S-9',
          supplierInvoiceDate: '2026-05-01',
        }),
      );
      expect(bill.selfInvoice).not.toBeNull();
      const out = await flow.cancelDocument(
        ctx,
        bill.document['id'],
        bill.document['version'],
        'Supplier withdrew it',
      );
      expect(out.alsoCancelled).toHaveLength(1);
      expect((await get(bill.selfInvoice!['id']))['status']).toBe('cancelled');
    });
  });

  describe('period lock', () => {
    it('blocks issuing, cancelling and financial edits inside the lock, and always allows notes', async () => {
      const own = await tenant(d);
      const f = new DocumentFlowRepo(d);
      const mk = async (date: string) => {
        const s = await f.saveDraft(own, rows(draft({ partyId: undefined as never, date })));
        return s.document;
      };
      const open = await mk('2026-01-10');
      const issued = await f.issueDraft(own, open['id'], open['version']);
      const draftInLock = await mk('2026-02-01');

      await new PeriodLockRepo(d).set(own, '2026-03-31');

      await expect(
        f.issueDraft(own, draftInLock['id'], draftInLock['version']),
      ).rejects.toBeInstanceOf(PeriodLockedError);
      await expect(
        f.cancelDocument(own, issued.document['id'], issued.document['version'], 'late'),
      ).rejects.toBeInstanceOf(PeriodLockedError);
      await expect(
        f.reviseIssued(own, {
          id: issued.document['id'],
          version: issued.document['version'],
          ...rows(draft({ date: '2026-01-10', lines: [line({ ratePaise: 1n })] })),
        }),
      ).rejects.toBeInstanceOf(PeriodLockedError);

      // notes and terms are never locked
      const noted = await f.editIssuedNotes(
        own,
        issued.document['id'],
        issued.document['version'],
        {
          notes: 'Delivered to gate 2',
        },
      );
      expect(noted['notes']).toBe('Delivered to gate 2');
      expect(noted['revision']).toBe(1);

      // a day after the lock is open
      const later = await mk('2026-04-01');
      await f.issueDraft(own, later['id'], later['version']);
    });

    it('lets only an owner override, with a reason, and writes it to the audit trail', async () => {
      const own = await tenant(d);
      const f = new DocumentFlowRepo(d);
      const s = await f.saveDraft(own, rows(draft({ date: '2026-01-10' })));
      await new PeriodLockRepo(d).set(own, '2026-03-31');

      const accountant: Ctx = { ...own, role: 'accountant' };
      await expect(
        f.issueDraft(accountant, s.document['id'], s.document['version'], {
          lockOverride: { reason: 'late entry' },
        }),
      ).rejects.toThrow(/Only an owner/);
      await expect(
        f.issueDraft(own, s.document['id'], s.document['version'], {
          lockOverride: { reason: ' ' },
        }),
      ).rejects.toThrow(/Say why/);

      const r = await f.issueDraft(own, s.document['id'], s.document['version'], {
        lockOverride: { reason: 'Customer asked for a January invoice' },
      });
      expect(r.document['status']).toBe('issued');
      const trail = (await new AuditRepo(d).documentHistory(own, r.document['id'])).filter(
        (a) => a['table_name'] === 'period_lock',
      );
      expect(trail).toHaveLength(1);
      expect(trail[0]!['after_json']).toMatchObject({
        override: 'Customer asked for a January invoice',
        action: 'issue',
      });
    });

    it('unlocking needs an owner and a reason; moving the lock later is free', async () => {
      const own = await tenant(d);
      const l = new PeriodLockRepo(d);
      await l.set(own, '2026-03-31');
      await l.set(own, '2026-06-30'); // later: fine
      await expect(l.set(own, '2026-03-31')).rejects.toThrow(/why/);
      await expect(
        new PeriodLockRepo(d).set({ ...own, role: 'staff' }, null, 'try'),
      ).rejects.toThrow(/Only an owner/);
      await l.set(own, null, 'Auditor found an error in April');
      expect(await l.get(own)).toBeNull();
      expect(lock).toBeDefined();
    });
  });

  describe('editing after issue', () => {
    it('a financial edit reposts the ledger and stock, bumps the revision and keeps the number', async () => {
      const item = await new ItemRepo(d).create(ctx, {
        name: 'Revisable bolt',
        track_stock: true,
        hsn: '7318',
        gst_rate_bp: 1800,
      });
      const r = await issue(
        draft({
          partyId,
          date: '2026-05-20',
          lines: [line({ itemId: item['id'], qtyMicros: 2_000_000n })],
        }),
        { inventoryEnabled: true },
      );
      const id = r.document['id'] as string;
      const before = await ledgerNet(id);

      const revised = await flow.reviseIssued(ctx, {
        id,
        version: r.document['version'],
        ...rows(
          draft({
            partyId,
            date: '2026-05-20',
            lines: [line({ itemId: item['id'], qtyMicros: 5_000_000n })],
          }),
        ),
      });
      expect(revised.kind).toBe('financial');
      expect(revised.document).toMatchObject({
        number: r.document['number'],
        status: 'issued',
        revision: 2,
      });

      // the ledger now nets to exactly what a fresh posting of the new totals would
      const after = await ledgerNet(id);
      const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
      expect(total(after.net)).toBe(0);
      const receivable = [...after.net.entries()].find(([, v]) => v > 0)!;
      expect(receivable[1]).toBe(Number(revised.document['total_paise']));
      expect(receivable[1]).toBeGreaterThan(
        [...before.net.values()].reduce((a, b) => Math.max(a, b), 0),
      );

      const moves = (await new BaseRepo(d, 'stock_movements').list(ctx)).filter(
        (m) => m['document_id'] === id,
      );
      expect(moves.reduce((n, m) => n + Number(m['qty_micros']), 0)).toBe(-5_000_000);

      // the audit trail holds before and after
      const history = await new AuditRepo(d).documentHistory(ctx, id);
      const upd = history.filter(
        (h) => h['table_name'] === 'documents' && h['action'] === 'update',
      );
      const last = upd[upd.length - 1]!;
      expect((last['before_json'] as any).revision).toBe(1);
      expect((last['after_json'] as any).revision).toBe(2);
      expect(history.some((h) => h['table_name'] === 'document_lines')).toBe(true);
    });

    it('notes, terms and references change without a new revision or a repost', async () => {
      const r = await issue(draft({ partyId, date: '2026-05-21' }));
      const ledgerBefore = (await ledgerNet(r.document['id'])).all.length;
      const out = await flow.editIssuedNotes(ctx, r.document['id'], r.document['version'], {
        notes: 'Thanks!',
        reference: { po: 'PO-77' },
      });
      expect(out).toMatchObject({ notes: 'Thanks!', revision: 1 });
      expect((out['metadata_json'] as any).refs).toEqual({ po: 'PO-77' });
      expect((await ledgerNet(r.document['id'])).all).toHaveLength(ledgerBefore);
    });

    it('via the editor path: a notes-only change is non-financial, an unchanged save writes nothing', async () => {
      const dr = draft({ partyId, date: '2026-05-22' });
      const r = await issue(dr);
      const same = await flow.reviseIssued(ctx, {
        id: r.document['id'],
        version: r.document['version'],
        ...rows(dr),
      });
      expect(same.kind).toBe('none');
      const noted = await flow.reviseIssued(ctx, {
        id: r.document['id'],
        version: r.document['version'],
        ...rows({ ...dr, notes: '<p>Hello</p>' }),
      });
      expect(noted.kind).toBe('non_financial');
      expect(noted.document['revision']).toBe(1);
    });

    it('refuses a financial edit of an e-invoiced document or one that moves to another year', async () => {
      const dr = draft({ partyId, date: '2026-05-23' });
      const r = await issue(dr);
      const bad = await flow
        .reviseIssued(ctx, {
          id: r.document['id'],
          version: r.document['version'],
          ...rows({ ...dr, date: '2027-05-23', lines: [line({ ratePaise: 9n })] }),
        })
        .catch((e: Error) => e);
      expect(bad).toBeInstanceOf(RuleError);
      expect(String((bad as Error).message)).toMatch(/financial year/);

      await new BaseRepo(d, 'documents').update(
        ctx,
        r.document['id'],
        { irn: 'b'.repeat(64) },
        r.document['version'],
      );
      await expect(
        flow.reviseIssued(ctx, {
          id: r.document['id'],
          version: r.document['version'] + 1,
          ...rows({ ...dr, lines: [line({ ratePaise: 7n })] }),
        }),
      ).rejects.toThrow(/e-invoiced/);
    });
  });

  describe('several devices', () => {
    it('gives provisional numbers until a range is reserved, then real ones; finalise swaps one in', async () => {
      const own = await tenant(d);
      const f = new DocumentFlowRepo(d);
      const n = new NumberingRepo(d);
      // one normal issue so the year has a counter
      const first = await issue(draft({ date: '2026-07-01' }), {}, own);
      expect(first.document['number']).toMatch(/\/0001$/);
      const key = (await n.listSeries(own, 'tax_invoice'))[0]!.key;

      await n.setMode(own, 'synced');
      const prov = await issue(draft({ date: '2026-07-02' }), {}, own);
      expect(prov.document['number']).toBe('PROV-0001');
      const prov2 = await issue(draft({ date: '2026-07-02' }), {}, own);
      expect(prov2.document['number']).toBe('PROV-0002');

      const range = await n.reserveRange(own, key, 3, '2026-07-02');
      expect(range.to - range.from).toBe(2);
      const a = await issue(draft({ date: '2026-07-03' }), {}, own);
      const b = await issue(draft({ date: '2026-07-03' }), {}, own);
      expect(a.document['number']).toBe(`INV/26-27/${String(range.from).padStart(4, '0')}`);
      expect(b.document['number']).toBe(`INV/26-27/${String(range.from + 1).padStart(4, '0')}`);

      // a second device's range never overlaps the first
      const other = await n.reserveRange({ ...own, deviceId: 'dev2' }, key, 2, '2026-07-03');
      expect(other.from).toBeGreaterThan(range.to);

      // the hook for sync: a provisional number becomes a real one from the counter
      const real = await f.finaliseNumber(own, prov.document['id']);
      expect(real['number']).toMatch(/^INV\/26-27\/\d{4}$/);
      expect(real['number']).not.toBe('PROV-0001');
      // finalising a real number changes nothing
      expect((await f.finaliseNumber(own, real['id']))['number']).toBe(real['number']);

      // unused numbers go back to the pool
      await n.releaseRange(own, other.id);
      const again = await n.reserveRange(own, key, 2, '2026-07-03');
      expect(again.from).toBe(other.from);
    });
  });
});
