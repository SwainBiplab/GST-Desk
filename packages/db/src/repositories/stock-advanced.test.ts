import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedPharma, type PharmaSeed } from '../seed-pharma';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, createOrganisation } from './aggregates';
import { BaseRepo, RuleError, runInTx, type Ctx } from './base';
import { BatchRepo, SerialRepo } from './batches';
import { ACCOUNTS } from './chart';
import { DocumentFlowRepo } from './document-flow';
import { GodownRepo, TransferRepo } from './godowns';
import { InsufficientStockError, InventoryRepo } from './inventory';
import { ItemRepo } from './items';
import { LedgerAudit, LedgerReports } from './ledger';
import { runReport } from './reports';
import { ValuationRepo } from './valuation';

const TODAY = '2026-11-01';
const u = (n: number) => Math.round(n * 1_000_000);
const rs = (n: number) => BigInt(Math.round(n * 100));

async function tenant(d: Database): Promise<Ctx> {
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = {
    orgId: org['id'],
    businessId: '',
    actor: 'tester',
    deviceId: 'dev',
    role: 'owner',
  };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Pharma', state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

let k = 0;
const line = (over: Partial<DraftLine>): DraftLine => ({
  ...emptyDraftLine(`t${++k}`),
  qtyMicros: 1_000_000n,
  gstRateBp: 1200,
  hsn: '3004',
  description: 'x',
  ...over,
});

describe.each(DIALECTS)('advanced inventory (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let seed: PharmaSeed;
  let flow: DocumentFlowRepo;
  let valuation: ValuationRepo;

  const issue = async (dr: DraftDocument) => {
    const rows = draftToRows(dr);
    const saved = await flow.saveDraft(ctx, {
      doc: rows.doc as unknown as Record<string, unknown>,
      lines: rows.lines as unknown as Record<string, unknown>[],
    });
    return flow.issueDraft(ctx, saved.document['id'], saved.document['version'], {
      inventoryEnabled: true,
    });
  };
  const sale = (lines: DraftLine[], date = TODAY): DraftDocument => ({
    ...emptyDraft('tax_invoice', date, { supplierState: '27' }),
    partyId: seed.customerId,
    lines,
  });
  const purchase = (lines: DraftLine[], date = TODAY): DraftDocument => ({
    ...emptyDraft('purchase_bill', date, { supplierState: '27' }),
    partyId: seed.supplierId,
    supplierInvoiceNo: `S-${++k}`,
    supplierInvoiceDate: date,
    lines,
  });
  const movementsOf = (documentId: string) =>
    new BaseRepo(d, 'stock_movements')
      .list(ctx)
      .then((r) => r.filter((m) => m['document_id'] === documentId));
  const ledgerOf = (documentId: string) =>
    new BaseRepo(d, 'ledger_entries')
      .list(ctx)
      .then((r) => r.filter((e) => e['document_id'] === documentId));
  const inventoryBalance = async () => {
    const accounts = await new LedgerReports(d).trialBalance(ctx, {
      from: '2020-01-01',
      to: '2099-12-31',
    });
    const inv = accounts.rows.find((r) => r.account.code === ACCOUNTS.inventory[0]);
    return inv ? inv.closingDrPaise - inv.closingCrPaise : 0n;
  };

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    flow = new DocumentFlowRepo(d);
    valuation = new ValuationRepo(d);
    seed = await seedPharma(d, ctx, { today: TODAY, method: 'fifo' });
  }, 120_000);
  afterAll(async () => {
    await d.close();
  });

  describe('the pharma seed', () => {
    it('sells first expiry first when no batch is chosen, splitting the line over batches', async () => {
      const m = await movementsOf(seed.documents['sale1']!);
      const pcm = m.filter((x) => x['item_id'] === seed.items.paracetamol);
      expect(pcm.map((x) => [x['batch_id'], Number(x['qty_micros'])]).sort()).toEqual(
        [
          [seed.batches['pcmA'], u(-100)],
          [seed.batches['pcmB'], u(-20)],
        ].sort(),
      );
      const batches = await new BatchRepo(d).of(ctx, seed.items.paracetamol);
      expect(batches.find((b) => b.id === seed.batches['pcmA'])!.onHandMicros).toBe(0);
      expect(batches.find((b) => b.id === seed.batches['pcmB'])!.onHandMicros).toBe(u(80));
    });

    it('costs the sale FIFO across the two purchase layers and posts it as cost of goods sold', async () => {
      const m = await movementsOf(seed.documents['sale1']!);
      const pcm = m.filter((x) => x['item_id'] === seed.items.paracetamol);
      // 100 at ₹20 (first batch) and 20 at ₹24 (second): ₹2,480
      expect(pcm.reduce((t, x) => t + Number(x['cost_paise']), 0)).toBe(Number(rs(2480)));
      const glu = m.find((x) => x['item_id'] === seed.items.glucometer)!;
      expect(Number(glu['cost_paise'])).toBe(Number(rs(2000)));
      const entries = await ledgerOf(seed.documents['sale1']!);
      const cogs = entries.filter((e) => String(e['narration']).startsWith('Cost of goods sold'));
      expect(cogs).toHaveLength(2);
      expect(
        cogs.reduce((t, e) => t + Number(e['debit_paise']) - Number(e['credit_paise']), 0),
      ).toBe(0);
      expect(Math.max(...cogs.map((e) => Number(e['debit_paise'])))).toBe(Number(rs(4480)));
    });

    it('the stock value under the method equals the Inventory ledger, and the books stay whole', async () => {
      const check = await valuation.verify(ctx);
      expect(check.method).toBe('fifo');
      expect(check.differencePaise).toBe(0n);
      expect(check.stockValuePaise).toBe(await inventoryBalance());
      expect(check.stockValuePaise).toBeGreaterThan(0n);
      const audit = await new LedgerAudit(d).verify(ctx, TODAY);
      expect(audit.documents.missing).toEqual([]);
      expect(audit.documents.unbalanced).toEqual([]);
      expect(audit.vouchers.unbalanced).toEqual([]);
      // the balance sheet still ties with stock on it
      const bs = await new LedgerReports(d).balanceSheet(ctx, '2099-12-31');
      expect(bs.differencePaise).toBe(0n);
    });

    it('a return brings the serial back in stock at the cost it went out, and an adjustment posts a voucher', async () => {
      const serials = new SerialRepo(d);
      expect((await serials.pick(ctx, seed.items.glucometer, 'GM-0001'))!.status).toBe('out');
      expect((await serials.pick(ctx, seed.items.glucometer, 'GM-0002'))!.status).toBe('in_stock');
      const ret = await movementsOf(seed.documents['return1']!);
      expect(Number(ret[0]!['cost_paise'])).toBe(Number(rs(1000)));
      const vouchers = await new BaseRepo(d, 'journal_vouchers').list(ctx);
      const damage = vouchers.find((v) => String(v['narration']).includes('damage'));
      expect(damage).toBeDefined();
      // two strips at ₹60
      expect(Number(damage!['total_paise'])).toBe(Number(rs(120)));
    });

    it('flags the batch expiring within the horizon and not the ones further out or sold out', async () => {
      const rows = await new BatchRepo(d).expiring(ctx, TODAY, 90);
      expect(rows.map((r) => r.batchNo)).toEqual(['AMX-A24']);
      expect(rows[0]!.daysLeft).toBe(20);
      expect(rows[0]!.onHandMicros).toBe(u(22));
      expect(rows[0]!.batchId).toBe(seed.batches['amxA']);
    });

    it('a transfer moves stock between godowns without changing what the business holds', async () => {
      const inv = new InventoryRepo(d);
      const detail = await inv.itemDetail(ctx, seed.items.paracetamol);
      expect(detail.onHandMicros).toBe(u(80));
      const by = new Map(detail.byGodown.map((g) => [g.godown.id, g.onHandMicros]));
      expect(by.get(seed.godowns.main)).toBe(u(60));
      expect(by.get(seed.godowns.cold)).toBe(u(20));
      const t = await new TransferRepo(d).getTransfer(ctx, seed.transferId);
      expect(t!.status).toBe('received');
      expect(t!.number).toMatch(/^TR\/26-27\/0001$/);
    });

    it('the stock reports agree with each other and with the valuation', async () => {
      const check = await valuation.verify(ctx);
      const p = { from: '2026-04-01', to: TODAY, today: TODAY };
      const byItem = await runReport(d, ctx, 'stock_value', p);
      const byBatch = await runReport(d, ctx, 'stock_value', { ...p, type: 'batch' });
      const byGodown = await runReport(d, ctx, 'stock_value', { ...p, type: 'godown' });
      expect(byItem.totals['value']).toBe(Number(check.stockValuePaise));
      expect(byBatch.totals['value']).toBe(Number(check.stockValuePaise));
      expect(byGodown.totals['value']).toBe(Number(check.stockValuePaise));
      const summary = await runReport(d, ctx, 'stock_summary', p);
      expect(summary.totals['value']).toBe(Number(check.stockValuePaise));
      const cold = await runReport(d, ctx, 'stock_summary', { ...p, godownId: seed.godowns.cold });
      expect(cold.rows.find((r) => r['id'] === seed.items.paracetamol)!['closing']).toBe(u(20));
      const expiry = await runReport(d, ctx, 'expiry', { ...p, to: '2027-01-30' });
      expect(expiry.rows.map((r) => r['batch'])).toEqual(['AMX-A24']);
      const ageing = await runReport(d, ctx, 'stock_ageing', p);
      expect(ageing.totals['qty']).toBe(Number(byItem.totals['qty']));
      const register = await runReport(d, ctx, 'movement_register', {
        ...p,
        godownId: seed.godowns.cold,
      });
      expect(register.rows.length).toBeGreaterThan(2);
      const dead = await runReport(d, ctx, 'dead_stock', { ...p, from: '2026-10-25' });
      // insulin sold ten days ago: idle for the last week
      expect(dead.rows.map((r) => r['id'])).toContain(seed.items.insulin);
    });
  });

  describe('rules', () => {
    it('a purchase of a batch item needs its batch, a required expiry is required, and a serial cannot come in twice', async () => {
      await expect(
        issue(
          purchase([
            line({ itemId: seed.items.paracetamol, qtyMicros: 10_000_000n, ratePaise: 2000n }),
          ]),
        ),
      ).rejects.toThrow(/batch/);
      await expect(
        new BatchRepo(d).ensure(ctx, { itemId: seed.items.paracetamol, batchNo: 'NOEXP' }),
      ).rejects.toThrow(/expiry/);
      await expect(
        issue(
          purchase([
            line({
              itemId: seed.items.glucometer,
              hsn: '9027',
              qtyMicros: 1_000_000n,
              ratePaise: 100000n,
              serials: ['GM-0002'],
            }),
          ]),
        ),
      ).rejects.toThrow(/already in stock/);
      await expect(
        issue(
          sale([
            line({
              itemId: seed.items.glucometer,
              hsn: '9027',
              qtyMicros: 1_000_000n,
              ratePaise: 150000n,
              serials: ['GM-0001'],
            }),
          ]),
        ),
      ).rejects.toThrow(/not in stock/);
      await expect(
        issue(
          sale([
            line({
              itemId: seed.items.glucometer,
              hsn: '9027',
              qtyMicros: 2_000_000n,
              ratePaise: 150000n,
              serials: ['GM-0003'],
            }),
          ]),
        ),
      ).rejects.toThrow(/one serial number per unit/);
    });

    it('a sale picks a batch per godown, and the block policy refuses when the batches are short', async () => {
      const inv = new InventoryRepo(d);
      await inv.setPolicy(ctx, 'block');
      try {
        await expect(
          issue(
            sale([
              line({ itemId: seed.items.paracetamol, qtyMicros: BigInt(u(70)), ratePaise: 3000n }),
            ]),
          ),
        ).rejects.toThrow(InsufficientStockError);
        // the cold store holds twenty: a sale from there of fifteen is fine
        const r = await issue(
          sale([
            line({
              itemId: seed.items.paracetamol,
              qtyMicros: BigInt(u(15)),
              ratePaise: 3000n,
              godownId: seed.godowns.cold,
            }),
          ]),
        );
        const m = await movementsOf(r.document['id']);
        expect(m).toHaveLength(1);
        expect(m[0]!['godown_id']).toBe(seed.godowns.cold);
        expect(m[0]!['batch_id']).toBe(seed.batches['pcmB']);
        expect((await valuation.verify(ctx)).differencePaise).toBe(0n);
      } finally {
        await inv.setPolicy(ctx, 'allow');
      }
    });

    it('cancelling a sale puts the goods and their cost back, and the valuation still ties', async () => {
      const before = await valuation.verify(ctx);
      const r = await issue(
        sale([
          line({
            itemId: seed.items.insulin,
            qtyMicros: 2_000_000n,
            ratePaise: 80000n,
            batchId: seed.batches['insA'],
            godownId: seed.godowns.cold,
          }),
        ]),
      );
      const mid = await valuation.verify(ctx);
      expect(mid.stockValuePaise).toBe(before.stockValuePaise - rs(1200));
      expect(mid.differencePaise).toBe(0n);
      await flow.cancelDocument(ctx, r.document['id'], r.document['version'], 'Entered in error', {
        date: TODAY,
      });
      const after = await valuation.verify(ctx);
      expect(after.stockValuePaise).toBe(before.stockValuePaise);
      expect(after.differencePaise).toBe(0n);
      const m = await movementsOf(r.document['id']);
      expect(
        m
          .map((x) => [
            Number(x['qty_micros']),
            Number(x['cost_paise']),
            !!x['cost_fixed'] || Number(x['cost_fixed']) === 1,
          ])
          .sort(),
      ).toEqual([
        [u(-2), Number(rs(1200)), false],
        [u(2), Number(rs(1200)), true],
      ]);
    });

    it('a two-step transfer keeps the business total, shows what is in transit, and can be cancelled', async () => {
      const transfers = new TransferRepo(d);
      const inv = new InventoryRepo(d);
      const total = (await inv.onHand(ctx, [seed.items.paracetamol])).get(seed.items.paracetamol)!;
      const t = await transfers.dispatch(ctx, {
        date: TODAY,
        fromGodownId: seed.godowns.main,
        toGodownId: seed.godowns.cold,
        lines: [
          { itemId: seed.items.paracetamol, batchId: seed.batches['pcmB'], qtyMicros: u(10) },
        ],
      });
      expect(t.status).toBe('dispatched');
      expect((await inv.onHand(ctx, [seed.items.paracetamol])).get(seed.items.paracetamol)).toBe(
        total,
      );
      expect((await transfers.inTransit(ctx)).get(seed.items.paracetamol)).toBe(u(10));
      const stock = await new GodownRepo(d).stock(ctx, { itemIds: [seed.items.paracetamol] });
      const at = (g: string) => stock.find((r) => r.godownId === g)?.onHandMicros ?? 0;
      expect(at(seed.godowns.main)).toBe(u(50));
      expect(at(seed.godowns.cold)).toBe(u(5));
      // too much, or into the same godown, is refused
      await expect(
        transfers.dispatch(ctx, {
          date: TODAY,
          fromGodownId: seed.godowns.main,
          toGodownId: seed.godowns.cold,
          lines: [
            { itemId: seed.items.paracetamol, batchId: seed.batches['pcmB'], qtyMicros: u(500) },
          ],
        }),
      ).rejects.toThrow(RuleError);
      await expect(
        transfers.dispatch(ctx, {
          date: TODAY,
          fromGodownId: seed.godowns.main,
          toGodownId: seed.godowns.main,
          lines: [],
        }),
      ).rejects.toThrow(/different/);
      const received = await transfers.receive(ctx, t.id, t.version, TODAY);
      expect(received.status).toBe('received');
      expect((await transfers.inTransit(ctx)).get(seed.items.paracetamol) ?? 0).toBe(0);
      const after = await new GodownRepo(d).stock(ctx, { itemIds: [seed.items.paracetamol] });
      expect(after.find((r) => r.godownId === seed.godowns.cold)!.onHandMicros).toBe(u(15));
      expect(after.reduce((s, r) => s + r.onHandMicros, 0)).toBe(total);
      // and the valuation never noticed
      expect((await valuation.verify(ctx)).differencePaise).toBe(0n);

      const t2 = await transfers.dispatch(ctx, {
        date: TODAY,
        fromGodownId: seed.godowns.cold,
        toGodownId: seed.godowns.main,
        lines: [{ itemId: seed.items.paracetamol, batchId: seed.batches['pcmB'], qtyMicros: u(5) }],
      });
      const cancelled = await transfers.cancel(ctx, t2.id, t2.version, 'Never left');
      expect(cancelled.status).toBe('cancelled');
      expect(
        (await new GodownRepo(d).stock(ctx, { itemIds: [seed.items.paracetamol] })).find(
          (r) => r.godownId === seed.godowns.cold,
        )!.onHandMicros,
      ).toBe(u(15));
    });

    it('serials move between godowns with a transfer', async () => {
      const transfers = new TransferRepo(d);
      const t = await transfers.dispatch(ctx, {
        date: TODAY,
        fromGodownId: seed.godowns.main,
        toGodownId: seed.godowns.cold,
        immediate: true,
        lines: [{ itemId: seed.items.glucometer, serials: ['GM-0003'], qtyMicros: u(1) }],
      });
      expect(t.status).toBe('received');
      const s = await new SerialRepo(d).pick(ctx, seed.items.glucometer, 'GM-0003');
      expect(s!.godownId).toBe(seed.godowns.cold);
      expect(s!.status).toBe('in_stock');
      await expect(
        transfers.dispatch(ctx, {
          date: TODAY,
          fromGodownId: seed.godowns.main,
          toGodownId: seed.godowns.cold,
          lines: [{ itemId: seed.items.glucometer, serials: ['GM-0003'], qtyMicros: u(1) }],
        }),
      ).rejects.toThrow(/not in/);
    });

    it('a count by godown books the difference there, with the batch', async () => {
      const inv = new InventoryRepo(d);
      const r = await inv.applyCount(ctx, {
        date: TODAY,
        godownId: seed.godowns.cold,
        counts: [
          { itemId: seed.items.paracetamol, countedMicros: u(13), batchId: seed.batches['pcmB'] },
        ],
      });
      expect(r.adjusted).toHaveLength(1);
      expect(r.adjusted[0]!.deltaMicros).toBe(u(-2));
      const stock = await new GodownRepo(d).stock(ctx, { itemIds: [seed.items.paracetamol] });
      expect(stock.find((x) => x.godownId === seed.godowns.cold)!.onHandMicros).toBe(u(13));
      expect((await valuation.verify(ctx)).differencePaise).toBe(0n);
    });

    it('per-godown reorder levels show shortages where they are', async () => {
      const godowns = new GodownRepo(d);
      await godowns.setLevel(ctx, seed.items.paracetamol, seed.godowns.cold, u(20));
      const low = await godowns.lowByGodown(ctx);
      expect(low.map((r) => [r.itemId, r.godownId])).toEqual([
        [seed.items.paracetamol, seed.godowns.cold],
      ]);
      await godowns.setLevel(ctx, seed.items.paracetamol, seed.godowns.cold, 0);
      expect(await godowns.lowByGodown(ctx)).toEqual([]);
    });

    it('tracking cannot change while the item has stock, and a godown with stock cannot be archived', async () => {
      const items = new ItemRepo(d);
      const item = (await items.get(ctx, seed.items.paracetamol))!;
      await expect(
        items.update(ctx, item['id'], { tracking_mode: 'none' }, item['version']),
      ).rejects.toThrow();
      const godowns = new GodownRepo(d);
      const cold = (await godowns.all(ctx)).find((g) => g.id === seed.godowns.cold)!;
      await expect(godowns.archive(ctx, cold.id, cold.version)).rejects.toThrow(/stock/);
    });
  });

  describe('valuation', () => {
    it('is locked once stock moved, and migrates to weighted average with one true-up voucher', async () => {
      expect(await valuation.locked(ctx)).toBe(true);
      await expect(valuation.set(ctx, 'wavg', { today: TODAY })).rejects.toThrow(/Migrate/);
      const before = await valuation.verify(ctx);
      const r = await valuation.set(ctx, 'wavg', { today: TODAY, migrate: true });
      expect(r.recosted).toBeGreaterThan(0);
      const after = await valuation.verify(ctx);
      expect(after.method).toBe('wavg');
      expect(after.differencePaise).toBe(0n);
      // paracetamol came in at 20 and 24: the average is between them, so the value changed
      expect(after.stockValuePaise).not.toBe(before.stockValuePaise);
      expect(r.voucherId).not.toBeNull();
      const v = await new BaseRepo(d, 'journal_vouchers').get(ctx, r.voucherId!);
      expect(String(v!['narration'])).toMatch(/FIFO to weighted average/);
      const audit = await new LedgerAudit(d).verify(ctx, TODAY);
      expect(audit.vouchers.unbalanced).toEqual([]);
    });

    it('a sale under weighted average is costed at the average, and a true-up with nothing to do posts nothing', async () => {
      const detail = await new InventoryRepo(d).itemDetail(ctx, seed.items.paracetamol);
      const r = await issue(
        sale([line({ itemId: seed.items.paracetamol, qtyMicros: 5_000_000n, ratePaise: 3000n })]),
      );
      const m = await movementsOf(r.document['id']);
      expect(m.reduce((t, x) => t + Number(x['cost_paise']), 0)).toBe(
        Number((BigInt(u(5)) * detail.unitCostPaise) / 1_000_000n),
      );
      expect(await valuation.trueUp(ctx, TODAY)).toBeNull();
    });

    it('a business without a method values stock at purchase price and posts nothing for stock', async () => {
      const other = await tenant(d);
      const item = (
        await new ItemRepo(d).create(other, {
          name: 'Plain',
          hsn: '7318',
          gst_rate_bp: 1800,
          track_stock: true,
          purchase_rate_paise: 1000,
          opening_stock_micros: u(4),
        })
      )['id'];
      const check = await new ValuationRepo(d).verify(other);
      expect(check.method).toBeNull();
      expect(check.stockValuePaise).toBe(rs(40));
      expect(check.ledgerPaise).toBe(0n);
      expect((await new BaseRepo(d, 'journal_vouchers').list(other)).length).toBe(0);
      // choosing a method brings the ledger to the stock value
      const set = await new ValuationRepo(d).set(other, 'fifo', { today: TODAY });
      expect(set.voucherId).not.toBeNull();
      expect((await new ValuationRepo(d).verify(other)).differencePaise).toBe(0n);
      expect((await new InventoryRepo(d).itemDetail(other, item)).valuePaise).toBe(rs(40));
    });
  });

  describe('serials at scale', () => {
    it('finds one serial among a hundred thousand in under 100 ms', async () => {
      const other = await tenant(d);
      const item = (
        await new ItemRepo(d).create(other, {
          name: 'Phone',
          hsn: '8517',
          gst_rate_bp: 1800,
          track_stock: true,
          tracking_mode: 'serial',
        })
      )['id'];
      const now = Date.now();
      await runInTx(d, other, async (tx) => {
        const t = d.schema.serials;
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < 100_000; i++) {
          rows.push({
            id: crypto.randomUUID(),
            org_id: other.orgId,
            business_id: other.businessId,
            version: 1,
            created_at: now,
            updated_at: now,
            created_by: 'seed',
            updated_by: 'seed',
            item_id: item,
            serial_no: `IMEI${String(i).padStart(9, '0')}`,
            status: i % 2 === 0 ? 'in_stock' : 'out',
          });
          if (rows.length === 500) {
            await tx.insert(t).values(rows.splice(0));
          }
        }
        if (rows.length > 0) await tx.insert(t).values(rows);
      });
      const serials = new SerialRepo(d);
      await serials.pick(other, item, 'IMEI000000000'); // warm
      const started = performance.now();
      for (const n of [1, 50_000, 99_999, 77_777, 12_345]) {
        const s = await serials.pick(other, item, `IMEI${String(n).padStart(9, '0')}`);
        expect(s!.status).toBe(n % 2 === 0 ? 'in_stock' : 'out');
      }
      const each = (performance.now() - started) / 5;
      expect(each).toBeLessThan(100);
      const states = await serials.states(other, item, ['IMEI000000002', 'IMEI000000003', 'nope']);
      expect([...states.entries()]).toEqual([
        ['IMEI000000002', 'in_stock'],
        ['IMEI000000003', 'out'],
      ]);
    }, 300_000);
  });
});
