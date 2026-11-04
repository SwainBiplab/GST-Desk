import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DocumentType,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { BaseRepo, RuleError, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { getPartyAccount, getPartyAccounts } from './parties';
import {
  BusinessAccountRepo,
  CreditAppliedError,
  PaymentFlowRepo,
  type PaymentInput,
} from './payment-flow';
import { PeriodLockRepo } from './period-lock';

const TODAY = '2026-12-31';

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
  ratePaise: 100_000n,
  gstRateBp: 0,
  ...over,
});
const draft = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
  placeOfSupply: '27',
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

describe.each(DIALECTS)('payments, allocations and credit (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let pays: PaymentFlowRepo;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    flow = new DocumentFlowRepo(d);
    pays = new PaymentFlowRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  const party = async (type = 'customer', name = 'Sharma') =>
    (await new PartyRepo(d).create(ctx, { type, name, state_code: '27' }))['id'] as string;

  /** An issued document of `rupees` (no GST, so total = rupees), for a party. */
  const issue = async (partyId: string, rupees: number, over: Partial<DraftDocument> = {}) => {
    const saved = await flow.saveDraft(
      ctx,
      rows(
        draft({
          partyId,
          partyName: 'X',
          lines: [line({ ratePaise: BigInt(rupees) * 100n })],
          ...over,
        }),
      ),
    );
    const r = await flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
    return r.document;
  };

  const receive = (
    partyId: string,
    rupees: number,
    allocations: PaymentInput['allocations'] = [],
    over: Partial<PaymentInput> = {},
  ): Promise<ReturnType<PaymentFlowRepo['record']>> =>
    pays.record(ctx, {
      direction: 'received',
      partyId,
      date: '2026-05-10',
      mode: 'cash',
      amountPaise: BigInt(rupees) * 100n,
      allocations,
      ...over,
    }) as never;

  const position = async (partyId: string) => {
    const { documents, credits } = await pays.positions(ctx, TODAY, partyId);
    return { documents, credits };
  };
  const balanceOfDoc = async (partyId: string, docId: string) =>
    (await position(partyId)).documents.find((x) => x.id === docId)!;

  /** What the ledger says the party owes: receivables less payables, from the party's entries. */
  const ledgerOwed = async (partyId: string) => {
    const accounts = new Map(
      (await new BaseRepo(d, 'ledger_accounts').list(ctx)).map((a) => [a['id'], a['code']]),
    );
    let owed = 0n;
    for (const e of await new BaseRepo(d, 'ledger_entries').list(ctx)) {
      if (e['party_id'] !== partyId) continue;
      const code = accounts.get(e['account_id']);
      const net = BigInt(e['debit_paise']) - BigInt(e['credit_paise']);
      if (code === '1200') owed += net;
      if (code === '2000') owed += net; // payables: debit less credit is negative when we owe
    }
    return owed;
  };
  /** The three figures that must agree for a party. */
  const reconcile = async (partyId: string) => {
    const engine = (await getPartyAccount(d, ctx, partyId, TODAY)).balancePaise;
    const outstanding = (await pays.partyPosition(ctx, partyId, TODAY)).outstandingPaise;
    const ledger = await ledgerOwed(partyId);
    return { engine, outstanding, ledger };
  };

  describe('receiving', () => {
    it('allocates part of a receipt, posts cash against receivables and issues a receipt voucher', async () => {
      const p = await party();
      const inv = await issue(p, 1000);
      const r = await receive(p, 400, [{ documentId: inv['id'], amountPaise: 40_000n }]);

      expect(r.payment).toMatchObject({ mode: 'cash', status: 'cleared', amount_paise: 40_000 });
      expect(r.remainderPaise).toBe(0n);
      expect(r.voucher).toMatchObject({
        type: 'receipt_voucher',
        status: 'issued',
        total_paise: 40_000,
      });
      expect(String(r.voucher!['number'])).toMatch(/^RV\/\d{2}-\d{2}\/\d{4}$/);
      expect(r.payment['voucher_id']).toBe(r.voucher!['id']);

      const pos = await balanceOfDoc(p, inv['id']);
      expect(pos).toMatchObject({ paidPaise: 40_000n, balancePaise: 60_000n, status: 'partial' });

      const entries = (await new BaseRepo(d, 'ledger_entries').list(ctx)).filter(
        (e) => e['payment_id'] === r.payment['id'],
      );
      expect(
        entries.map((e) => [Number(e['debit_paise']), Number(e['credit_paise'])]).sort(),
      ).toEqual([
        [0, 40_000],
        [40_000, 0],
      ]);
      expect(await reconcile(p)).toEqual({
        engine: 60_000n,
        outstanding: 60_000n,
        ledger: 60_000n,
      });
    });

    it('settles an invoice in full and marks it paid', async () => {
      const p = await party();
      const inv = await issue(p, 250);
      await receive(p, 250, [{ documentId: inv['id'], amountPaise: 25_000n }]);
      expect((await balanceOfDoc(p, inv['id'])).status).toBe('paid');
      expect((await pays.openDocuments(ctx, p, 'received', TODAY)).map((x) => x.id)).not.toContain(
        inv['id'],
      );
    });

    it('lists open documents oldest first', async () => {
      const p = await party();
      const later = await issue(p, 100, { date: '2026-06-20', dueDate: '2026-07-20' });
      const earlier = await issue(p, 100, { date: '2026-06-01', dueDate: '2026-06-15' });
      expect((await pays.openDocuments(ctx, p, 'received', TODAY)).map((x) => x.id)).toEqual([
        earlier['id'],
        later['id'],
      ]);
    });

    it('refuses what the rules refuse: too much, wrong party, wrong kind, draft, no amount, cheque details', async () => {
      const p = await party();
      const other = await party('customer', 'Other');
      const inv = await issue(p, 100);
      const otherInv = await issue(other, 100);
      const cn = await issue(p, 10, { type: 'credit_note' as DocumentType });

      await expect(
        receive(p, 200, [{ documentId: inv['id'], amountPaise: 10_001n }]),
      ).rejects.toThrow(/more than what is owed/);
      await expect(
        receive(p, 50, [{ documentId: inv['id'], amountPaise: 6_000n }]),
      ).rejects.toThrow(/more than the amount received/);
      await expect(
        receive(p, 50, [{ documentId: otherInv['id'], amountPaise: 5_000n }]),
      ).rejects.toThrow(/not open for this party/);
      await expect(receive(p, 5, [{ documentId: cn['id'], amountPaise: 500n }])).rejects.toThrow(
        /not open for this party/,
      );
      const draftDoc = await flow.saveDraft(ctx, rows(draft({ partyId: p })));
      await expect(
        receive(p, 5, [{ documentId: draftDoc.document['id'], amountPaise: 500n }]),
      ).rejects.toThrow(/not open for this party/);
      await expect(receive(p, 0)).rejects.toThrow(/more than zero/);
      await expect(receive(p, 50, [], { mode: 'cheque' })).rejects.toThrow(
        /cheque needs its number/,
      );
      await expect(receive(p, 50, [], { mode: 'cheque', reference: '000123' })).rejects.toThrow(
        /cheque needs its date/,
      );
      // nothing was written by any of those
      expect((await pays.listPayments(ctx, { partyId: p })).length).toBe(0);
      const ok = await receive(p, 50, [], {
        mode: 'cheque',
        reference: '000123',
        chequeDate: '2026-05-12',
      });
      expect(ok.payment).toMatchObject({ reference: '000123', cheque_date: '2026-05-12' });
    });

    it('a failure part-way writes nothing', async () => {
      const p = await party();
      const inv = await issue(p, 100);
      const before = (await new BaseRepo(d, 'ledger_entries').list(ctx)).length;
      const real = (pays as any).createVoucherIn;
      (pays as any).createVoucherIn = () => {
        throw new Error('disk full');
      };
      try {
        await expect(
          receive(p, 100, [{ documentId: inv['id'], amountPaise: 10_000n }]),
        ).rejects.toThrow('disk full');
      } finally {
        (pays as any).createVoucherIn = real;
      }
      expect((await new BaseRepo(d, 'ledger_entries').list(ctx)).length).toBe(before);
      expect((await pays.listPayments(ctx, { partyId: p })).length).toBe(0);
      expect((await balanceOfDoc(p, inv['id'])).balancePaise).toBe(10_000n);
    });
  });

  describe('payments made', () => {
    it('settles a purchase bill and posts payables against bank', async () => {
      const s = await party('supplier', 'Supplier');
      const bill = await issue(s, 800, {
        type: 'purchase_bill',
        supplierInvoiceNo: 'S-1',
        supplierInvoiceDate: '2026-05-01',
      });
      const r = (await pays.record(ctx, {
        direction: 'made',
        partyId: s,
        date: '2026-05-12',
        mode: 'bank',
        amountPaise: 30_000n,
        allocations: [{ documentId: bill['id'], amountPaise: 30_000n }],
      })) as Awaited<ReturnType<PaymentFlowRepo['record']>>;
      expect(r.voucher).toBeNull(); // receipts get a voucher; payments made do not
      expect((await balanceOfDoc(s, bill['id'])).status).toBe('partial');
      const rec = await reconcile(s);
      expect(rec.engine).toBe(rec.outstanding);
      expect(rec.engine).toBe(rec.ledger);
      expect(rec.engine).toBe(-50_000n); // we still owe them Rs 500
    });

    it('will not pay an invoice with a payment made', async () => {
      const p = await party();
      const inv = await issue(p, 100);
      await expect(
        pays.record(ctx, {
          direction: 'made',
          partyId: p,
          date: '2026-05-12',
          mode: 'bank',
          amountPaise: 5_000n,
          allocations: [{ documentId: inv['id'], amountPaise: 5_000n }],
        }),
      ).rejects.toThrow(/not open for this party/);
    });
  });

  describe('credit', () => {
    it('an overpayment is carried as party credit and applied to the next invoice', async () => {
      const p = await party();
      const first = await issue(p, 300);
      const r = await receive(p, 500, [{ documentId: first['id'], amountPaise: 30_000n }]);
      expect(r.remainderPaise).toBe(20_000n);
      expect(
        (await pays.creditSources(ctx, p, 'received', TODAY)).map((c) => c.remainingPaise),
      ).toEqual([20_000n]);
      // party owes nothing; the books show the advance
      expect(await reconcile(p)).toEqual({
        engine: -20_000n,
        outstanding: -20_000n,
        ledger: -20_000n,
      });

      const next = await issue(p, 120);
      const plan = await pays.planCredit(ctx, next['id'], TODAY);
      expect(plan.map((x) => x.amountPaise)).toEqual([12_000n]);
      const used = await pays.applyCredit(
        ctx,
        {
          documentId: next['id'],
          uses: plan.map((x) => ({
            kind: x.source.kind,
            id: x.source.id,
            amountPaise: x.amountPaise,
          })),
        },
        TODAY,
      );
      expect(used[0]).toMatchObject({
        kind: 'credit_applied',
        payment_id: r.payment['id'],
        source_document_id: r.voucher!['id'],
        amount_paise: 12_000,
      });
      expect((await balanceOfDoc(p, next['id'])).status).toBe('paid');
      expect((await pays.creditSources(ctx, p, 'received', TODAY))[0]!.remainingPaise).toBe(8_000n);
      // applying credit moves no money: the party figures are unchanged
      expect(await reconcile(p)).toEqual({
        engine: -8_000n,
        outstanding: -8_000n,
        ledger: -8_000n,
      });
    });

    it('never applies more than the source has, or than the document owes', async () => {
      const p = await party();
      const inv1 = await issue(p, 100);
      const r = await receive(p, 200, [{ documentId: inv1['id'], amountPaise: 10_000n }]);
      const inv2 = await issue(p, 50);
      const src = (await pays.creditSources(ctx, p, 'received', TODAY))[0]!;
      await expect(
        pays.applyCredit(
          ctx,
          { documentId: inv2['id'], uses: [{ kind: 'payment', id: src.id, amountPaise: 6_000n }] },
          TODAY,
        ),
      ).rejects.toThrow(/more credit than the document owes/i);
      const inv3 = await issue(p, 500);
      await expect(
        pays.applyCredit(
          ctx,
          { documentId: inv3['id'], uses: [{ kind: 'payment', id: src.id, amountPaise: 10_001n }] },
          TODAY,
        ),
      ).rejects.toThrow(/left on/);
      expect(r.remainderPaise).toBe(10_000n);
    });

    it('a credit note is credit too, applied with no payment behind it', async () => {
      const p = await party();
      const inv = await issue(p, 500);
      const cn = await issue(p, 200, { type: 'credit_note' });
      expect((await pays.creditSources(ctx, p, 'received', TODAY))[0]).toMatchObject({
        kind: 'document',
        id: cn['id'],
        remainingPaise: 20_000n,
      });
      await pays.applyCredit(
        ctx,
        { documentId: inv['id'], uses: [{ kind: 'document', id: cn['id'], amountPaise: 15_000n }] },
        TODAY,
      );
      const a = (await new BaseRepo(d, 'payment_allocations').list(ctx)).find(
        (x) => x['source_document_id'] === cn['id'],
      )!;
      expect(a).toMatchObject({ payment_id: null, kind: 'credit_applied', amount_paise: 15_000 });
      expect((await balanceOfDoc(p, inv['id'])).balancePaise).toBe(35_000n);
      expect((await pays.creditSources(ctx, p, 'received', TODAY))[0]!.remainingPaise).toBe(5_000n);
      expect(await reconcile(p)).toEqual({
        engine: 30_000n,
        outstanding: 30_000n,
        ledger: 30_000n,
      });
    });

    it('credit that has been applied blocks deleting its source, unless forced (FR-053)', async () => {
      const p = await party();
      const inv1 = await issue(p, 100);
      const r = await receive(p, 300, [{ documentId: inv1['id'], amountPaise: 10_000n }]);
      const inv2 = await issue(p, 150);
      await pays.applyCredit(
        ctx,
        {
          documentId: inv2['id'],
          uses: [{ kind: 'payment', id: r.payment['id'], amountPaise: 15_000n }],
        },
        TODAY,
      );
      const refused = await pays.remove(ctx, r.payment['id']).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(CreditAppliedError);
      expect((refused as CreditAppliedError).documents).toHaveLength(1);
      expect((await pays.listPayments(ctx, { partyId: p })).length).toBe(1);

      const forced = await pays.remove(ctx, r.payment['id'], { force: true });
      expect(forced.unappliedDocuments).toEqual([inv2['id']]);
      expect((await balanceOfDoc(p, inv2['id'])).balancePaise).toBe(15_000n);
      expect((await balanceOfDoc(p, inv1['id'])).balancePaise).toBe(10_000n);
    });

    it('a credit note with credit applied cannot be cancelled quietly', async () => {
      // cancelling a source with applied credit unapplies it: cancelDocument returns the allocations
      const p = await party();
      const inv = await issue(p, 100);
      const cn = await issue(p, 60, { type: 'credit_note' });
      await pays.applyCredit(
        ctx,
        { documentId: inv['id'], uses: [{ kind: 'document', id: cn['id'], amountPaise: 6_000n }] },
        TODAY,
      );
      await flow.cancelDocument(ctx, cn['id'], cn['version'], 'issued in error');
      expect((await balanceOfDoc(p, inv['id'])).balancePaise).toBe(10_000n);
    });
  });

  describe('TCS on receipt, write-offs and adjustments', () => {
    it('collects TCS on the part of a receipt above Rs 50 lakh, posts it to TCS payable, and does not settle the customer with it', async () => {
      const p = await party('customer', 'Big buyer');
      const inv = await issue(p, 6_000_000, { date: '2024-06-01' });
      await receive(p, 4_900_000, [{ documentId: inv['id'], amountPaise: 490_000_000n }], {
        date: '2024-06-05',
      });
      // 49 lakh received; 11 lakh more crosses the threshold by 10 lakh -> 0.1% = Rs 1,000
      const tcs = await pays.tcsFor(ctx, p, '2024-06-20', 110_000_000n);
      expect(tcs.tcsPaise).toBe(100_000n);
      const r = await receive(
        p,
        1_101_000,
        [{ documentId: inv['id'], amountPaise: 110_000_000n }],
        {
          date: '2024-06-20',
          tcsPaise: tcs.tcsPaise,
        },
      );
      expect(r.payment['tcs_paise']).toBe(100_000);
      const tcsEntry = (await new BaseRepo(d, 'ledger_entries').list(ctx)).find(
        (e) => e['payment_id'] === r.payment['id'] && Number(e['credit_paise']) === 100_000,
      );
      expect(tcsEntry).toBeDefined();
      expect((await balanceOfDoc(p, inv['id'])).paidPaise).toBe(600_000_000n);
      expect((await balanceOfDoc(p, inv['id'])).status).toBe('paid');
      expect(await reconcile(p)).toEqual({ engine: 0n, outstanding: 0n, ledger: 0n });
    });

    it('no TCS from 1 October 2024', async () => {
      const p = await party('customer', 'Later buyer');
      const t = await pays.tcsFor(ctx, p, '2024-10-01', 900_000_000n);
      expect(t.tcsPaise).toBe(0n);
    });

    it('writes off up to 99 paise to round-off when it closes the document', async () => {
      const p = await party();
      const inv = await issue(p, 100); // Rs 100.00
      // customer pays Rs 99.60; the 40 paise left are written off
      const ok = await pays.record(ctx, {
        direction: 'received',
        partyId: p,
        date: '2026-05-10',
        mode: 'upi',
        amountPaise: 9_960n,
        allocations: [{ documentId: inv['id'], amountPaise: 9_960n, writeOffPaise: 40n }],
      });
      expect(ok.remainderPaise).toBe(0n);
      expect(await balanceOfDoc(p, inv['id'])).toMatchObject({
        writtenOffPaise: 40n,
        balancePaise: 0n,
        status: 'paid',
      });
      expect(await reconcile(p)).toEqual({ engine: 0n, outstanding: 0n, ledger: 0n });
      await expect(
        pays.record(ctx, {
          direction: 'received',
          partyId: p,
          date: '2026-05-10',
          mode: 'cash',
          amountPaise: 1_000n,
          allocations: [
            { documentId: (await issue(p, 100))['id'], amountPaise: 1_000n, writeOffPaise: 100n },
          ],
        }),
      ).rejects.toThrow(/up to 99 paise/);
    });

    it('an adjustment reduces what is owed without moving money', async () => {
      const p = await party();
      const inv = await issue(p, 100);
      await pays.record(ctx, {
        direction: 'received',
        partyId: p,
        date: '2026-05-10',
        mode: 'adjustment',
        amountPaise: 2_000n,
        allocations: [{ documentId: inv['id'], amountPaise: 2_000n }],
      });
      const rec = await reconcile(p);
      expect(rec).toEqual({ engine: 8_000n, outstanding: 8_000n, ledger: 8_000n });
      const cash = (await new BaseRepo(d, 'ledger_accounts').list(ctx)).find(
        (a) => a['code'] === '1000',
      )!;
      const moved = (await new BaseRepo(d, 'ledger_entries').list(ctx)).filter(
        (e) =>
          e['account_id'] === cash['id'] && e['party_id'] === null && e['narration'] === 'receipt',
      );
      expect(moved.every((e) => Number(e['debit_paise']) !== 2_000)).toBe(true);
    });
  });

  describe('editing, deleting and undoing', () => {
    it('editing re-posts the ledger and gives the voucher a new revision', async () => {
      const p = await party();
      const inv = await issue(p, 500);
      const r = await receive(p, 100, [{ documentId: inv['id'], amountPaise: 10_000n }]);
      const edited = await pays.edit(ctx, r.payment['id'], r.payment['version'], {
        direction: 'received',
        partyId: p,
        date: '2026-05-11',
        mode: 'bank',
        amountPaise: 25_000n,
        reference: 'UTR1',
        allocations: [{ documentId: inv['id'], amountPaise: 25_000n }],
      });
      expect(edited.payment).toMatchObject({
        mode: 'bank',
        amount_paise: 25_000,
        reference: 'UTR1',
      });
      expect(edited.voucher).toMatchObject({
        revision: 2,
        total_paise: 25_000,
        number: r.voucher!['number'],
      });
      expect((await balanceOfDoc(p, inv['id'])).balancePaise).toBe(25_000n);
      expect(await reconcile(p)).toEqual({
        engine: 25_000n,
        outstanding: 25_000n,
        ledger: 25_000n,
      });
      // the audit trail has before and after
      const trail = await new AuditRepo(d).forRow(ctx, 'payments', r.payment['id']);
      expect(trail.filter((a) => a['action'] === 'update').length).toBeGreaterThan(0);
    });

    it('cannot edit below credit already applied from the payment', async () => {
      const p = await party();
      const inv = await issue(p, 100);
      const r = await receive(p, 300, [{ documentId: inv['id'], amountPaise: 10_000n }]);
      const inv2 = await issue(p, 150);
      await pays.applyCredit(
        ctx,
        {
          documentId: inv2['id'],
          uses: [{ kind: 'payment', id: r.payment['id'], amountPaise: 15_000n }],
        },
        TODAY,
      );
      await expect(
        pays.edit(ctx, r.payment['id'], r.payment['version'], {
          direction: 'received',
          partyId: p,
          date: '2026-05-10',
          mode: 'cash',
          amountPaise: 12_000n,
          allocations: [{ documentId: inv['id'], amountPaise: 10_000n }],
        }),
      ).rejects.toThrow(/already been applied/);
      // nothing changed
      expect((await balanceOfDoc(p, inv['id'])).paidPaise).toBe(10_000n);
    });

    it('deleting reverses the ledger, restores the balance, cancels the voucher and is audited (undo)', async () => {
      const p = await party();
      const inv = await issue(p, 500);
      const r = await receive(p, 200, [{ documentId: inv['id'], amountPaise: 20_000n }]);
      expect((await balanceOfDoc(p, inv['id'])).balancePaise).toBe(30_000n);

      await pays.remove(ctx, r.payment['id']);
      expect(await balanceOfDoc(p, inv['id'])).toMatchObject({
        balancePaise: 50_000n,
        status: 'unpaid',
      });
      expect(await reconcile(p)).toEqual({
        engine: 50_000n,
        outstanding: 50_000n,
        ledger: 50_000n,
      });
      expect((await pays.listPayments(ctx, { partyId: p })).length).toBe(0);
      const voucher = (await flow.load(ctx, r.voucher!['id']))!.document;
      expect(voucher).toMatchObject({
        status: 'cancelled',
        number: r.voucher!['number'],
        cancel_reason: 'Payment deleted',
      });
      const trail = await new AuditRepo(d).forRow(ctx, 'payments', r.payment['id']);
      expect(trail.map((a) => a['action'])).toContain('soft_delete');
    });

    it('a payment dated in a locked period needs an owner override', async () => {
      const own = await tenant(d);
      const f = new DocumentFlowRepo(d);
      const pp = (
        await new PartyRepo(d).create(own, { type: 'customer', name: 'L', state_code: '27' })
      )['id'];
      const s = await f.saveDraft(own, rows(draft({ partyId: pp, date: '2026-01-10' })));
      const issued = await f.issueDraft(own, s.document['id'], s.document['version']);
      await new PeriodLockRepo(d).set(own, '2026-03-31');
      const input: PaymentInput = {
        direction: 'received',
        partyId: pp,
        date: '2026-02-01',
        mode: 'cash',
        amountPaise: 10_000n,
        allocations: [{ documentId: issued.document['id'], amountPaise: 10_000n }],
      };
      await expect(new PaymentFlowRepo(d).record(own, input)).rejects.toThrow(/locked/);
      const done = await new PaymentFlowRepo(d).record(own, input, {
        lockOverride: { reason: 'late entry' },
      });
      expect(done.payment['status']).toBe('cleared');
    });
  });

  describe('reconciliation', () => {
    it('invoice, partial payment, credit note, overpayment and credit application all agree', async () => {
      const p = await party('both', 'Mixed');
      const inv1 = await issue(p, 1000, { date: '2026-04-05' });
      await receive(p, 400, [{ documentId: inv1['id'], amountPaise: 40_000n }]);
      const cn = await issue(p, 100, { type: 'credit_note', date: '2026-04-20' });
      expect(await reconcile(p)).toMatchObject({ engine: 50_000n });
      const inv2 = await issue(p, 300, { date: '2026-05-01' });
      // pays Rs 900 against the Rs 600 left on invoice 1 and Rs 300 on invoice 2... then Rs 100 more as advance
      const r = await receive(
        p,
        1000,
        [
          { documentId: inv1['id'], amountPaise: 60_000n },
          { documentId: inv2['id'], amountPaise: 30_000n },
        ],
        { date: '2026-05-15' },
      );
      expect(r.remainderPaise).toBe(10_000n);
      const rec1 = await reconcile(p);
      expect(rec1.engine).toBe(rec1.outstanding);
      expect(rec1.engine).toBe(rec1.ledger);
      expect(rec1.engine).toBe(-20_000n); // advance 100 + credit note 100 unused

      const inv3 = await issue(p, 500, { date: '2026-06-01' });
      const plan = await pays.planCredit(ctx, inv3['id'], TODAY);
      expect(plan.reduce((n, x) => n + x.amountPaise, 0n)).toBe(20_000n);
      await pays.applyCredit(
        ctx,
        {
          documentId: inv3['id'],
          uses: plan.map((x) => ({
            kind: x.source.kind,
            id: x.source.id,
            amountPaise: x.amountPaise,
          })),
        },
        TODAY,
      );
      const rec2 = await reconcile(p);
      expect(rec2).toEqual({ engine: 30_000n, outstanding: 30_000n, ledger: 30_000n });
      expect(await balanceOfDoc(p, inv3['id'])).toMatchObject({
        balancePaise: 30_000n,
        status: 'partial',
      });
      expect((await position(p)).credits.find((c) => c.id === cn['id'])!.balancePaise).toBe(0n);
    });

    it('Party 360 outstanding, document balances and ledger receivables agree for every seeded party', async () => {
      const seeded = await openTestDb(dialect);
      try {
        const { ctx: sctx } = await seedDemo(seeded);
        const repo = new PaymentFlowRepo(seeded);
        const accounts = await getPartyAccounts(seeded, sctx, '2026-06-30');
        const codes = new Map(
          (await new BaseRepo(seeded, 'ledger_accounts').list(sctx)).map((a) => [
            a['id'],
            a['code'],
          ]),
        );
        const owed = new Map<string, bigint>();
        for (const e of await new BaseRepo(seeded, 'ledger_entries').list(sctx)) {
          if (!e['party_id']) continue;
          const code = codes.get(e['account_id']);
          const net = BigInt(e['debit_paise']) - BigInt(e['credit_paise']);
          if (code === '1200') owed.set(e['party_id'], (owed.get(e['party_id']) ?? 0n) + net);
          if (code === '2000') owed.set(e['party_id'], (owed.get(e['party_id']) ?? 0n) + net);
        }
        expect(accounts.size).toBe(50);
        const bad: string[] = [];
        for (const [partyId, acc] of accounts) {
          const pos = await repo.partyPosition(sctx, partyId, '2026-06-30');
          const ledger = owed.get(partyId) ?? 0n;
          if (acc.balancePaise !== pos.outstandingPaise || acc.balancePaise !== ledger)
            bad.push(
              `${partyId}: engine ${acc.balancePaise}, documents ${pos.outstandingPaise}, ledger ${ledger}`,
            );
        }
        expect(bad).toEqual([]);
      } finally {
        await seeded.close();
      }
    }, 120_000);
  });

  describe('receipts for payments that have none', () => {
    it('makes a numbered receipt on demand, once, for money received only', async () => {
      const p = await party();
      const inv = await issue(p, 300);
      const r = await receive(p, 100, [{ documentId: inv['id'], amountPaise: 10_000n }]);
      // as demo data and older payments are: no receipt
      await new BaseRepo(d, 'payments').update(
        ctx,
        r.payment['id'],
        { voucher_id: null },
        r.payment['version'],
      );
      await new BaseRepo(d, 'payments').get(ctx, r.payment['id']);

      const made = await pays.createReceipt(ctx, r.payment['id']);
      expect(made).toMatchObject({
        type: 'receipt_voucher',
        status: 'issued',
        total_paise: 10_000,
      });
      expect(String(made['number'])).toMatch(/^RV\//);
      expect((made['metadata_json'] as { allocations: unknown[] }).allocations).toHaveLength(1);
      const row = (await pays.listPayments(ctx, { partyId: p }))[0]!;
      expect(row.voucherNumber).toBe(made['number']);
      // again: the same receipt, no new number
      expect((await pays.createReceipt(ctx, r.payment['id']))['id']).toBe(made['id']);

      const s = await party('supplier', 'Sup');
      const bill = await issue(s, 100, {
        type: 'purchase_bill',
        supplierInvoiceNo: 'S-5',
        supplierInvoiceDate: '2026-05-01',
      });
      const out = await pays.record(ctx, {
        direction: 'made',
        partyId: s,
        date: '2026-05-12',
        mode: 'bank',
        amountPaise: 10_000n,
        allocations: [{ documentId: bill['id'], amountPaise: 10_000n }],
      });
      await expect(pays.createReceipt(ctx, out.payment['id'])).rejects.toThrow(/money received/);
    });
  });

  describe('lists and the day book', () => {
    it('filters payments and reads the day book from the cash ledger', async () => {
      const own = await tenant(d);
      const pf = new PaymentFlowRepo(d);
      const f = new DocumentFlowRepo(d);
      const pid = (
        await new PartyRepo(d).create(own, {
          type: 'customer',
          name: 'Ravi Stores',
          state_code: '27',
        })
      )['id'];
      const saved = await f.saveDraft(own, rows(draft({ partyId: pid, date: '2026-07-01' })));
      const inv = await f.issueDraft(own, saved.document['id'], saved.document['version']);
      const base = { direction: 'received' as const, partyId: pid, allocations: [] };
      await pf.record(own, {
        ...base,
        date: '2026-07-02',
        mode: 'cash',
        amountPaise: 30_000n,
        allocations: [{ documentId: inv.document['id'], amountPaise: 30_000n }],
      });
      await pf.record(own, { ...base, date: '2026-07-03', mode: 'cash', amountPaise: 20_000n });
      await pf.record(own, {
        ...base,
        date: '2026-07-03',
        mode: 'upi',
        amountPaise: 5_000n,
        reference: 'UTR9',
      });

      expect((await pf.listPayments(own, { mode: 'upi' })).map((x) => x.amountPaise)).toEqual([
        5_000n,
      ]);
      expect((await pf.listPayments(own, { q: 'ravi' })).length).toBe(3);
      expect((await pf.listPayments(own, { q: 'utr9' })).length).toBe(1);
      expect((await pf.listPayments(own, { from: '2026-07-03', to: '2026-07-03' })).length).toBe(2);
      const row = (
        await pf.listPayments(own, { mode: 'cash', from: '2026-07-02', to: '2026-07-02' })
      )[0]!;
      expect(row).toMatchObject({
        partyName: 'Ravi Stores',
        allocatedPaise: 30_000n,
        unallocatedPaise: 0n,
      });
      expect(row.voucherNumber).toMatch(/^RV\//);

      const book = await pf.dayBook(own, '2026-07-03');
      expect(book).toMatchObject({
        openingPaise: 30_000n,
        inPaise: 20_000n,
        outPaise: 0n,
        closingPaise: 50_000n,
      });
      expect(book.entries).toHaveLength(1);
      expect((await pf.dayBook(own, '2026-06-30')).closingPaise).toBe(0n);
    });
  });

  describe('business accounts', () => {
    it('validates bank and UPI details, keeps one default, and picks what prints on documents', async () => {
      const own = await tenant(d);
      const acc = new BusinessAccountRepo(d);
      await expect(
        acc.createAccount(own, { kind: 'bank', name: 'HDFC', ifsc: 'BAD', accountNo: '123456789' }),
      ).rejects.toThrow(/IFSC/);
      await expect(
        acc.createAccount(own, { kind: 'upi', name: 'GPay', upiId: 'nope' }),
      ).rejects.toThrow(/UPI/);
      await expect(
        acc.createAccount(own, { kind: 'bank', name: 'x', accountNo: '12' }),
      ).rejects.toThrow(/digits/);

      const bank = await acc.createAccount(own, {
        kind: 'bank',
        name: 'HDFC Current',
        holderName: 'Demo Traders',
        accountNo: '50100123456789',
        ifsc: 'hdfc0001234',
        accountType: 'current',
      });
      expect(bank).toMatchObject({
        is_default: true,
        ifsc: 'HDFC0001234',
        show_on_documents: true,
      });
      const upi = await acc.createAccount(own, {
        kind: 'upi',
        name: 'Shop UPI',
        upiId: 'shop@okhdfc',
        isDefault: true,
        showOnDocuments: false,
      });
      const all = await acc.listAccounts(own);
      expect(all.filter((a) => a['is_default']).map((a) => a['name'])).toEqual(['Shop UPI']);
      expect((await acc.forDocuments(own)).map((a) => a['name'])).toEqual(['HDFC Current']);
      const renamed = await acc.updateAccount(own, upi['id'], upi['version'], {
        kind: 'upi',
        name: 'Shop UPI',
        upiId: 'shop@okhdfc',
        showOnDocuments: true,
      });
      expect(renamed['show_on_documents']).toBe(true);
      const current = (await acc.listAccounts(own)).find((a) => a['id'] === bank['id'])!;
      await acc.removeAccount(own, bank['id'], current['version']);
      expect((await acc.listAccounts(own)).map((a) => a['name'])).toEqual(['Shop UPI']);
    });
  });

  it('the error type for a rule is a RuleError', () => {
    expect(new CreditAppliedError('x', [])).toBeInstanceOf(RuleError);
  });
});
