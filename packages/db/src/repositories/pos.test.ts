import { emptyDraftLine, type DraftLine } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { InventoryRepo } from './inventory';
import { ItemRepo } from './items';
import { LedgerAudit, LedgerReports } from './ledger';
import { PosRepo } from './pos';

const DAY = '2026-11-02';
const rs = (n: number) => BigInt(Math.round(n * 100));
const u = (n: number) => BigInt(Math.round(n * 1_000_000));

async function tenant(d: Database, name = 'Corner Store'): Promise<Ctx> {
  const org = await createOrganisation(d, `Org ${name}`);
  const base: Ctx = {
    orgId: org['id'],
    businessId: '',
    actor: 'cashier',
    deviceId: 'till',
    role: 'owner',
  };
  const biz = await new BusinessRepo(d).create(base, { legal_name: name, state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

let k = 0;
const line = (
  item: { id: string; name: string },
  qty: number,
  ratePaise: bigint,
  over: Partial<DraftLine> = {},
): DraftLine => ({
  ...emptyDraftLine(`p${++k}`),
  itemId: item.id,
  description: item.name,
  hsn: '1905',
  qtyMicros: u(qty),
  ratePaise,
  gstRateBp: 1800,
  ...over,
});

describe.each(DIALECTS)('counter billing (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let pos: PosRepo;
  let biscuit: { id: string; name: string };
  let soap: { id: string; name: string };
  let c1: string;
  let c2: string;
  let shift1: string;

  const stockOf = async (id: string) => (await new InventoryRepo(d).onHand(ctx, [id])).get(id) ?? 0;
  const docs = () => new BaseRepo(d, 'documents').list(ctx);

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant(d);
    pos = new PosRepo(d);
    const items = new ItemRepo(d);
    const mk = async (name: string, sku: string, barcode: string | null) => {
      const row = await items.create(ctx, {
        name,
        sku,
        barcode,
        hsn: '1905',
        gst_rate_bp: 1800,
        sale_rate_paise: 5000,
        purchase_rate_paise: 3000,
        track_stock: true,
        opening_stock_micros: Number(u(100_000)),
      });
      return { id: String(row['id']), name };
    };
    biscuit = await mk('Marie biscuit', 'BIS-1', null);
    soap = await mk('Bath soap', 'SOAP-1', null);
    c1 = (await pos.addCounter(ctx, { name: 'Counter 1' })).id;
    c2 = (await pos.addCounter(ctx, { name: 'Counter 2' })).id;
  }, 120_000);
  afterAll(async () => {
    await d.close();
  });

  it('makes one walk-in customer, and a number series for each counter', async () => {
    const a = await pos.walkInPartyId(ctx);
    expect(await pos.walkInPartyId(ctx)).toBe(a);
    const party = await new PartyRepo(d).get(ctx, a);
    expect(party!['is_unregistered']).toBeTruthy();
    expect(party!['state_code']).toBe('27');
    const counters = await pos.allCounters(ctx);
    expect(counters.map((c) => c.name)).toEqual(['Counter 1', 'Counter 2']);
    expect(new Set(counters.map((c) => c.seriesKey)).size).toBe(2);
    await expect(pos.addCounter(ctx, { name: 'counter 1' })).rejects.toThrow(/already exists/);
  });

  it('opens one shift per counter, with a float', async () => {
    await expect(pos.openShift(ctx, { counterId: c1, floatPaise: -1n })).rejects.toThrow(
      /negative/,
    );
    const s = await pos.openShift(ctx, {
      counterId: c1,
      floatPaise: rs(2000),
      cashier: 'Asha',
      now: Date.parse(`${DAY}T09:00:00+05:30`),
    });
    shift1 = s.id;
    expect(s.status).toBe('open');
    expect((await pos.currentShift(ctx, c1))!.id).toBe(s.id);
    await expect(pos.openShift(ctx, { counterId: c1, floatPaise: 0n })).rejects.toThrow(
      /already has a shift open/,
    );
  });

  it('a cash sale gives change, takes the next number of its counter, moves stock and needs no receipt voucher', async () => {
    const before = await stockOf(biscuit.id);
    const r = await pos.sell(ctx, {
      shiftId: shift1,
      lines: [line(biscuit, 3, 5000n), line(soap, 1, 3500n)],
      tenders: [{ mode: 'cash', amountPaise: rs(500) }],
      date: DAY,
      inventoryEnabled: true,
    });
    // (3 x 50 + 35) = 185 + 18% = 218.30, rounded to the rupee
    const total = BigInt(r.document['total_paise'] as number);
    expect(total).toBe(rs(218));
    expect(r.settlement.changePaise).toBe(rs(500) - total);
    expect(String(r.document['number'])).toMatch(/^C1\/0001$/);
    expect(r.document['type']).toBe('tax_invoice');
    expect(await stockOf(biscuit.id)).toBe(before - Number(u(3)));
    // the bill is paid in full by one cash payment, and no receipt voucher was made for it
    const payments = await new BaseRepo(d, 'payments').list(ctx);
    expect(payments.filter((p) => r.paymentIds.includes(String(p['id'])))).toHaveLength(1);
    expect(Number(payments.find((p) => p['id'] === r.paymentIds[0])!['amount_paise'])).toBe(
      Number(total),
    );
    expect((await docs()).filter((x) => x['type'] === 'receipt_voucher')).toHaveLength(0);
    // the till's second bill is the second number, and the other counter has its own first
    const s2 = await pos.openShift(ctx, { counterId: c2, floatPaise: 0n });
    const other = await pos.sell(ctx, {
      shiftId: s2.id,
      lines: [line(soap, 1, 3500n)],
      tenders: [{ mode: 'upi', amountPaise: rs(41), reference: 'U1' }],
      date: DAY,
    });
    expect(String(other.document['number'])).toMatch(/^C2\/0001$/);
    const next = await pos.sell(ctx, {
      shiftId: shift1,
      lines: [line(soap, 1, 3500n)],
      tenders: [{ mode: 'cash', amountPaise: rs(100) }],
      date: DAY,
      inventoryEnabled: true,
    });
    expect(String(next.document['number'])).toMatch(/\/0002$/);
    await pos.closeShift(ctx, { shiftId: s2.id, countedPaise: 0n });
  });

  it('splits a bill over cash, UPI and card; refuses payments that do not fit and writes nothing', async () => {
    const lines = [line(biscuit, 10, 5000n)]; // 500 + 90 = 590
    const documentsBefore = (await docs()).length;
    await expect(
      pos.sell(ctx, {
        shiftId: shift1,
        lines,
        tenders: [{ mode: 'cash', amountPaise: rs(100) }],
        date: DAY,
      }),
    ).rejects.toThrow(/fall short/);
    await expect(
      pos.sell(ctx, {
        shiftId: shift1,
        lines,
        tenders: [
          { mode: 'upi', amountPaise: rs(400) },
          { mode: 'card', amountPaise: rs(300) },
        ],
        date: DAY,
      }),
    ).rejects.toThrow(/do not fit/);
    expect((await docs()).length).toBe(documentsBefore);
    const r = await pos.sell(ctx, {
      shiftId: shift1,
      lines,
      tenders: [
        { mode: 'upi', amountPaise: rs(300), reference: 'UPI-77' },
        { mode: 'card', amountPaise: rs(150), reference: 'AUTH-5' },
        { mode: 'cash', amountPaise: rs(200) },
      ],
      date: DAY,
      inventoryEnabled: true,
    });
    expect(r.settlement.applied.map((a) => [a.mode, a.amountPaise])).toEqual([
      ['upi', rs(300)],
      ['card', rs(150)],
      ['cash', rs(140)],
    ]);
    expect(r.settlement.changePaise).toBe(rs(60));
    const pays = (await new BaseRepo(d, 'payments').list(ctx)).filter((p) =>
      r.paymentIds.includes(String(p['id'])),
    );
    expect(pays.map((p) => p['mode']).sort()).toEqual(['card', 'cash', 'upi']);
    expect(pays.reduce((t, p) => t + Number(p['amount_paise']), 0)).toBe(Number(rs(590)));
    expect(pays.find((p) => p['mode'] === 'upi')!['reference']).toBe('UPI-77');
  });

  it('applies a line discount through the engine, and bills an out-of-state customer with IGST', async () => {
    const out = await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'Delhi Traders',
      state_code: '07',
      gstin: null,
    });
    const r = await pos.sell(ctx, {
      shiftId: shift1,
      partyId: String(out['id']),
      lines: [line(biscuit, 4, 5000n, { discountValue: 1000n })], // 10% off 200 = 180 taxable
      tenders: [{ mode: 'card', amountPaise: rs(212), reference: 'A1' }],
      date: DAY,
    });
    expect(Number(r.document['total_taxable_paise'])).toBe(Number(rs(180)));
    expect(Number(r.document['total_igst_paise'])).toBe(Number(rs(32.4)));
    expect(Number(r.document['total_cgst_paise'])).toBe(0);
    expect(BigInt(r.document['total_paise'] as number)).toBe(rs(212));
  });

  it('holds a bill, lists it and gives it back whole, once', async () => {
    const lines = [line(biscuit, 2, 5000n), line(soap, 1, 3500n, { note: 'gift wrap' })];
    const held = await pos.hold(ctx, {
      counterId: c1,
      lines,
      label: 'Man in blue',
      totalPaise: rs(100),
    });
    await expect(pos.hold(ctx, { counterId: c1, lines: [] })).rejects.toThrow(/nothing/);
    expect((await pos.heldBills(ctx, c1)).map((h) => h.label)).toEqual(['Man in blue']);
    const back = await pos.recall(ctx, held.id);
    expect(back.lines).toHaveLength(2);
    expect(back.lines[0]!.qtyMicros).toBe(u(2));
    expect(back.lines[0]!.ratePaise).toBe(5000n);
    expect(back.lines[1]!.note).toBe('gift wrap');
    expect(await pos.heldBills(ctx, c1)).toEqual([]);
    await expect(pos.recall(ctx, held.id)).rejects.toThrow();
  });

  it('takes goods back against a bill: stock returns, cash leaves the drawer, and no more than was sold', async () => {
    const sale = await pos.sell(ctx, {
      shiftId: shift1,
      lines: [line(soap, 4, 5000n)], // 200 + 36 = 236
      tenders: [{ mode: 'cash', amountPaise: rs(236) }],
      date: DAY,
      inventoryEnabled: true,
    });
    const number = String(sale.document['number']);
    const found = (await pos.findBill(ctx, number))!;
    expect(found.lines).toHaveLength(1);
    expect(found.fullyReturned).toBe(false);
    expect(await pos.findBill(ctx, 'NOPE/1')).toBeNull();
    const stockBefore = await stockOf(soap.id);
    const r = await pos.sellReturn(ctx, {
      shiftId: shift1,
      sourceDocumentId: String(sale.document['id']),
      lines: [{ lineNo: 1, qtyMicros: u(1) }],
      refundMode: 'cash',
      date: DAY,
      inventoryEnabled: true,
    });
    expect(r.creditNote['type']).toBe('credit_note');
    expect(r.refundPaise).toBe(rs(59));
    expect(await stockOf(soap.id)).toBe(stockBefore + Number(u(1)));
    const again = (await pos.findBill(ctx, number))!;
    expect(again.lines[0]!.returnedMicros).toBe(u(1));
    await expect(
      pos.sellReturn(ctx, {
        shiftId: shift1,
        sourceDocumentId: String(sale.document['id']),
        lines: [{ lineNo: 1, qtyMicros: u(4) }],
        refundMode: 'cash',
        date: DAY,
      }),
    ).rejects.toThrow(/left to return/);
    await expect(
      pos.sellReturn(ctx, {
        shiftId: shift1,
        sourceDocumentId: String(sale.document['id']),
        lines: [{ lineNo: 9, qtyMicros: u(1) }],
        refundMode: 'cash',
        date: DAY,
      }),
    ).rejects.toThrow(/no line 9/);
    // the rest comes back, and the bill is then fully returned
    await pos.sellReturn(ctx, {
      shiftId: shift1,
      sourceDocumentId: String(sale.document['id']),
      lines: [{ lineNo: 1, qtyMicros: u(3) }],
      refundMode: 'upi',
      date: DAY,
      inventoryEnabled: true,
    });
    expect((await pos.findBill(ctx, number))!.fullyReturned).toBe(true);
  });

  it('a return on a bill of several lines counts against the line that came back, not the credit note’s own numbering', async () => {
    const sale = await pos.sell(ctx, {
      shiftId: shift1,
      lines: [line(biscuit, 2, 5000n), line(soap, 3, 3500n)],
      tenders: [{ mode: 'cash', amountPaise: rs(1000) }],
      date: DAY,
      inventoryEnabled: true,
    });
    const number = String(sale.document['number']);
    // line 2 (soap) comes back one at a time, then biscuit once: each is counted on its own line
    await pos.sellReturn(ctx, {
      shiftId: shift1,
      sourceDocumentId: String(sale.document['id']),
      lines: [{ lineNo: 2, qtyMicros: u(1) }],
      refundMode: 'cash',
      date: DAY,
      inventoryEnabled: true,
    });
    let found = (await pos.findBill(ctx, number))!;
    expect(found.lines.map((l) => l.returnedMicros)).toEqual([0n, u(1)]);
    await pos.sellReturn(ctx, {
      shiftId: shift1,
      sourceDocumentId: String(sale.document['id']),
      lines: [
        { lineNo: 1, qtyMicros: u(1) },
        { lineNo: 2, qtyMicros: u(1) },
      ],
      refundMode: 'upi',
      date: DAY,
      inventoryEnabled: true,
    });
    found = (await pos.findBill(ctx, number))!;
    expect(found.lines.map((l) => l.returnedMicros)).toEqual([u(1), u(2)]);
    await expect(
      pos.sellReturn(ctx, {
        shiftId: shift1,
        sourceDocumentId: String(sale.document['id']),
        lines: [{ lineNo: 2, qtyMicros: u(2) }],
        refundMode: 'cash',
        date: DAY,
      }),
    ).rejects.toThrow(/Line 2: only 1 left/);
    // and the rest, so the next test's counts stay as they were
    await pos.sellReturn(ctx, {
      shiftId: shift1,
      sourceDocumentId: String(sale.document['id']),
      lines: [
        { lineNo: 1, qtyMicros: u(1) },
        { lineNo: 2, qtyMicros: u(1) },
      ],
      refundMode: 'cash',
      date: DAY,
      inventoryEnabled: true,
    });
    expect((await pos.findBill(ctx, number))!.fullyReturned).toBe(true);
  });

  it('the shift report adds up, and closing records the variance against the cash that should be there', async () => {
    await pos.cashMovement(ctx, {
      shiftId: shift1,
      kind: 'out',
      amountPaise: rs(300),
      reason: 'Milk for the staff',
    });
    await pos.cashMovement(ctx, {
      shiftId: shift1,
      kind: 'in',
      amountPaise: rs(100),
      reason: 'Float top-up',
    });
    await expect(
      pos.cashMovement(ctx, { shiftId: shift1, kind: 'out', amountPaise: rs(5), reason: ' ' }),
    ).rejects.toThrow(/what the cash was for/);
    const report = await pos.shiftReport(ctx, shift1);
    const z = report.z;
    expect(z.salesCount).toBe(6);
    expect(z.returnsCount).toBe(5);
    expect(Object.values(z.byMode).reduce((t, v) => t + v, 0n)).toBe(z.netPaise);
    expect(z.netPaise).toBe(z.salesPaise - z.returnsPaise);
    // the drawer: what the cash payments and cash refunds on the books say, plus the float and the hand movements
    const payments = await new BaseRepo(d, 'payments').list(ctx);
    const cashTaken = payments
      .filter((p) => p['direction'] === 'received' && p['mode'] === 'cash')
      .reduce((t, p) => t + BigInt(Number(p['amount_paise'])), 0n);
    const cashGiven = payments
      .filter((p) => p['direction'] === 'made' && p['mode'] === 'cash')
      .reduce((t, p) => t + BigInt(Number(p['amount_paise'])), 0n);
    expect(z.drawer.cashSalesPaise).toBe(cashTaken);
    expect(z.drawer.cashRefundsPaise).toBe(cashGiven);
    expect(cashGiven).toBeGreaterThanOrEqual(rs(59));
    expect(z.drawer.expectedPaise).toBe(rs(2000) + cashTaken - cashGiven + rs(100) - rs(300));
    // tax on the report is the documents' own, returns taken off
    const taxable = (await docs())
      .filter((x) => report.bills.some((b) => b.documentId === x['id']))
      .reduce(
        (t, x) => t + (x['type'] === 'credit_note' ? -1 : 1) * Number(x['total_taxable_paise']),
        0,
      );
    expect(Number(z.tax.taxablePaise)).toBe(taxable);

    const counted = z.drawer.expectedPaise - rs(25);
    const closed = await pos.closeShift(ctx, {
      shiftId: shift1,
      countedPaise: counted,
      note: 'Two ten-rupee notes missing',
      now: Date.parse(`${DAY}T21:00:00+05:30`),
    });
    expect(closed.status).toBe('short');
    expect(closed.variancePaise).toBe(-rs(25));
    expect(closed.shift.status).toBe('closed');
    expect(closed.shift.expectedCashPaise).toBe(z.drawer.expectedPaise);
    expect(closed.shift.variancePaise).toBe(-rs(25));
    await expect(pos.closeShift(ctx, { shiftId: shift1, countedPaise: 0n })).rejects.toThrow(
      /already closed/,
    );
    await expect(
      pos.sell(ctx, {
        shiftId: shift1,
        lines: [line(soap, 1, 3500n)],
        tenders: [{ mode: 'cash', amountPaise: rs(100) }],
        date: DAY,
      }),
    ).rejects.toThrow(/closed/);
    expect(await pos.currentShift(ctx, c1)).toBeNull();
  });

  it("the day's Z report adds the day's shifts, and each shift lists its variance", async () => {
    const day = await pos.dayReport(ctx, DAY);
    // shift 1 was opened on the sale date; counter 2's shift was opened today, in real time
    expect(day.shifts).toBe(1);
    expect(day.counters).toBe(1);
    expect(day.z.salesCount).toBe(6);
    expect(day.z.returnsCount).toBe(5);
    const listed = await pos.shiftsOfDay(ctx, DAY);
    expect(listed.map((x) => [x.counterName, x.variancePaise])).toEqual([['Counter 1', -rs(25)]]);
    const today = new Date().toISOString().slice(0, 10);
    const now = await pos.dayReport(ctx, today);
    expect(now.z.salesCount).toBe(1);
    expect((await pos.shiftsOfDay(ctx, today)).map((x) => x.counterName)).toEqual(['Counter 2']);
    expect((await pos.dayReport(ctx, '2020-01-01')).shifts).toBe(0);
  });

  it('the books still tie after counter sales and returns', async () => {
    const audit = await new LedgerAudit(d).verify(ctx, DAY);
    expect(audit.documents.missing).toEqual([]);
    expect(audit.documents.unbalanced).toEqual([]);
    expect(audit.payments.missing).toEqual([]);
    expect(audit.control.differencePaise).toBe(0n);
    const bs = await new LedgerReports(d).balanceSheet(ctx, '2099-12-31');
    expect(bs.differencePaise).toBe(0n);
  });

  it('a counter can be given a block of its own numbers to bill from', async () => {
    const r = await pos.reserveNumbers(ctx, c2, 50, DAY);
    expect(r.to - r.from + 1).toBe(50);
    const again = await pos.reserveNumbers(ctx, c2, 50, DAY);
    expect(again.from).toBeGreaterThan(r.to);
    await expect(pos.reserveNumbers(ctx, 'no-such-counter', 10, DAY)).rejects.toThrow();
  });

  it('serves a day of bills without slowing down', async () => {
    const own = await tenant(d, 'Busy Store');
    const p = new PosRepo(d);
    const item = await new ItemRepo(d).create(own, {
      name: 'Tea 250 g',
      sku: 'TEA',
      hsn: '0902',
      gst_rate_bp: 500,
      sale_rate_paise: 12000,
      purchase_rate_paise: 9000,
      track_stock: true,
      opening_stock_micros: Number(u(1_000_000)),
    });
    const tea = { id: String(item['id']), name: 'Tea 250 g' };
    const counter = await p.addCounter(own, { name: 'Main' });
    const shift = await p.openShift(own, { counterId: counter.id, floatPaise: rs(1000) });
    const bills = dialect === 'sqlite' ? 500 : 60;
    const times: number[] = [];
    for (let i = 0; i < bills; i++) {
      const q = 1 + (i % 3);
      const total = rs(126 * q); // 120 a pack, 5% GST
      const t0 = performance.now();
      await p.sell(own, {
        shiftId: shift.id,
        lines: [line(tea, q, 12000n, { hsn: '0902', gstRateBp: 500 })],
        // every other bill is UPI for exactly the total; the rest are cash handed over as a note
        tenders: [
          i % 2
            ? { mode: 'upi', amountPaise: total, reference: `U${i}` }
            : { mode: 'cash', amountPaise: rs(500) },
        ],
        date: DAY,
        inventoryEnabled: true,
      });
      times.push(performance.now() - t0);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const head = mean(times.slice(0, 50));
    const tail = mean(times.slice(-50));
    // the last fifty cost about what the first fifty did (generous: a shared CI machine is noisy)
    expect(tail).toBeLessThan(head * 3 + 20);
    const z = (await p.shiftReport(own, shift.id)).z;
    expect(z.salesCount).toBe(bills);
    expect(Object.values(z.byMode).reduce((t, v) => t + v, 0n)).toBe(z.salesPaise);
    const audit = await new LedgerAudit(d).verify(own, DAY);
    expect(audit.documents.missing).toEqual([]);
    expect(audit.control.differencePaise).toBe(0n);
  }, 600_000);
});
