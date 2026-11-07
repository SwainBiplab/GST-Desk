import { describe, expect, it } from 'vitest';

import {
  ageStock,
  checkSerials,
  fefoOrder,
  parseSerials,
  pickFefo,
  postStock,
  runValuation,
  serialCountMatches,
  valueAt,
  type StockEvent,
} from '../src';

const u = (n: number) => Math.round(n * 1_000_000);
const rs = (n: number) => BigInt(Math.round(n * 100));
let k = 0;
const ev = (date: string, qty: number, cost: number | null): StockEvent => ({
  id: `e${++k}`,
  date,
  qtyMicros: u(qty),
  costPaise: cost === null ? null : rs(cost),
});

describe('FIFO', () => {
  it('takes the oldest layer first, across partial layers', () => {
    const buy1 = ev('2026-04-01', 10, 1000); // ₹100 each
    const buy2 = ev('2026-04-05', 10, 1500); // ₹150 each
    const sale = ev('2026-04-10', -12, null);
    const r = runValuation('fifo', [buy1, buy2, sale]);
    // 10 at 100 + 2 at 150
    expect(r.costs.get(sale.id)).toBe(rs(1300));
    expect(r.qtyMicros).toBe(u(8));
    expect(r.valuePaise).toBe(rs(1200));
    expect(r.unitCostPaise).toBe(rs(150));
    expect(r.layers).toEqual([{ date: '2026-04-05', qtyMicros: u(8), costPaise: rs(1200) }]);
  });

  it('a sales return comes back at the cost of what is on hand, and a reversal at exactly what it took', () => {
    const buy1 = ev('2026-04-01', 10, 1000);
    const buy2 = ev('2026-04-05', 10, 2000);
    const sale = ev('2026-04-10', -15, null); // 10 at 100 + 5 at 200 = 2000
    const back = ev('2026-04-12', 1, null); // at the current unit cost: 200
    const r = runValuation('fifo', [buy1, buy2, sale, back]);
    expect(r.costs.get(sale.id)).toBe(rs(2000));
    expect(r.costs.get(back.id)).toBe(rs(200));
    expect(r.valuePaise).toBe(rs(1200));
    // the sale is cancelled: everything it took comes back, as a fixed cost
    const rev = { ...ev('2026-04-13', 15, 2000) };
    const r2 = runValuation('fifo', [buy1, buy2, sale, rev]);
    expect(r2.valuePaise).toBe(rs(3000));
    expect(r2.qtyMicros).toBe(u(20));
  });

  it('values stock that went negative at the last known cost and fills the hole on the next purchase', () => {
    const sale = ev('2026-04-01', -3, null);
    const buy = ev('2026-04-02', 10, 1000);
    const r = runValuation('fifo', [sale, buy], rs(90));
    expect(r.costs.get(sale.id)).toBe(rs(270)); // 3 at the fallback ₹90
    expect(r.qtyMicros).toBe(u(7));
    expect(r.valuePaise).toBe(rs(730));
    expect(r.layers[0]!.qtyMicros).toBe(u(7));
  });

  it('empties the value when the last unit goes, whatever rounding was left', () => {
    const buy = ev('2026-04-01', 3, 100); // ₹33.33 each
    const s1 = ev('2026-04-02', -1, null);
    const s2 = ev('2026-04-03', -2, null);
    const r = runValuation('fifo', [buy, s1, s2]);
    expect(r.costs.get(s1.id)! + r.costs.get(s2.id)!).toBe(rs(100));
    expect(r.valuePaise).toBe(0n);
    expect(r.layers).toEqual([]);
  });

  it('a revaluation moves the value and not the units', () => {
    const buy = ev('2026-04-01', 10, 1000);
    const down = ev('2026-04-02', 0, -200);
    const r = runValuation('fifo', [buy, down]);
    expect(r.valuePaise).toBe(rs(800));
    expect(r.unitCostPaise).toBe(rs(80));
    expect(r.layers[0]!.costPaise).toBe(rs(800));
  });
});

describe('weighted average', () => {
  it('takes every unit out at the running average, and a return comes back at it', () => {
    const buy1 = ev('2026-04-01', 10, 1000); // 100 each
    const buy2 = ev('2026-04-05', 10, 2000); // 200 each: average 150
    const sale = ev('2026-04-10', -4, null);
    const back = ev('2026-04-11', 1, null);
    const r = runValuation('wavg', [buy1, buy2, sale, back]);
    expect(r.costs.get(sale.id)).toBe(rs(600));
    expect(r.costs.get(back.id)).toBe(rs(150));
    expect(r.qtyMicros).toBe(u(17));
    expect(r.valuePaise).toBe(rs(2550));
    expect(r.unitCostPaise).toBe(rs(150));
  });

  it('a purchase after a sale changes the average for what follows, and all out means zero value', () => {
    const buy1 = ev('2026-04-01', 10, 1000);
    const s1 = ev('2026-04-02', -5, null); // 500
    const buy2 = ev('2026-04-03', 5, 1000); // now 10 at 150
    const s2 = ev('2026-04-04', -10, null); // 1500
    const r = runValuation('wavg', [buy1, s1, buy2, s2]);
    expect(r.costs.get(s1.id)).toBe(rs(500));
    expect(r.costs.get(s2.id)).toBe(rs(1500));
    expect(r.valuePaise).toBe(0n);
    expect(r.qtyMicros).toBe(0);
  });

  it('processes by date, whatever order the events were given in', () => {
    const late = ev('2026-04-10', -5, null);
    const early = ev('2026-04-01', 10, 1000);
    const r = runValuation('wavg', [late, early]);
    expect(r.costs.get(late.id)).toBe(rs(500));
  });

  it('the value of what is on hand always equals ins less outs as costed', () => {
    const rnd = mulberry(7);
    for (let round = 0; round < 50; round++) {
      const events: StockEvent[] = [];
      let qty = 0;
      for (let i = 0; i < 30; i++) {
        const day = `2026-04-${String(1 + (i % 28)).padStart(2, '0')}`;
        if (qty === 0 || rnd() < 0.5) {
          const q = 1 + Math.floor(rnd() * 20);
          events.push(ev(day, q, Math.floor(rnd() * 500) + 1));
          qty += q;
        } else {
          const q = 1 + Math.floor(rnd() * qty);
          events.push(ev(day, -q, null));
          qty -= q;
        }
      }
      // the days wrap, so in date order the stock may dip below zero on the way
      let running = 0;
      let dipped = false;
      for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
        running += e.qtyMicros;
        if (running < 0) dipped = true;
      }
      for (const method of ['fifo', 'wavg'] as const) {
        const r = runValuation(method, events);
        let net = 0n;
        for (const e of events) net += (e.qtyMicros < 0 ? -1n : 1n) * r.costs.get(e.id)!;
        expect(r.valuePaise, method).toBe(net);
        expect(r.qtyMicros).toBe(u(qty));
        if (qty === 0 && !dipped) expect(r.valuePaise).toBe(0n);
        if (qty > 0) {
          expect(r.layers.reduce((t, l) => t + l.qtyMicros, 0)).toBe(u(qty));
          expect(r.layers.reduce((t, l) => t + l.costPaise, 0n)).toBe(r.valuePaise);
        } else expect(r.layers).toEqual([]);
      }
    }
  });
});

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ageing', () => {
  it('buckets what is on hand by the day its layer came in', () => {
    const layers = [
      { date: '2026-04-01', qtyMicros: u(5), costPaise: rs(500) },
      { date: '2026-02-01', qtyMicros: u(2), costPaise: rs(200) },
      { date: '2025-06-01', qtyMicros: u(1), costPaise: rs(100) },
    ];
    const a = ageStock(layers, '2026-04-20');
    expect(a.qtyMicros).toEqual([u(5), 0, u(2), 0, u(1)]);
    expect(a.valuePaise).toEqual([rs(500), 0n, rs(200), 0n, rs(100)]);
  });

  it('quantity times unit cost rounds to whole paise', () => {
    expect(valueAt(u(3), rs(33.33))).toBe(rs(99.99));
    expect(valueAt(u(0.5), rs(1))).toBe(50n);
  });
});

describe('first expiry, first out', () => {
  const batches = [
    { batchId: 'b', batchNo: 'B2', expiryDate: '2026-12-31', availableMicros: u(5) },
    { batchId: 'a', batchNo: 'B1', expiryDate: '2026-06-30', availableMicros: u(3) },
    { batchId: 'n', batchNo: 'B0', expiryDate: null, availableMicros: u(10) },
    { batchId: 'x', batchNo: 'B9', expiryDate: '2026-01-31', availableMicros: u(4) },
  ];

  it('orders by expiry, batches without one last', () => {
    expect(fefoOrder(batches).map((b) => b.batchNo)).toEqual(['B9', 'B1', 'B2', 'B0']);
  });

  it('skips expired batches, takes the soonest first, and reports a shortfall', () => {
    const r = pickFefo(batches, u(7), { today: '2026-04-01' });
    expect(r.expiredSkipped).toBe(1);
    expect(r.picks).toEqual([
      { batchId: 'a', qtyMicros: u(3) },
      { batchId: 'b', qtyMicros: u(4) },
    ]);
    expect(r.shortMicros).toBe(0);
    const short = pickFefo(batches, u(30), { today: '2026-04-01' });
    expect(short.shortMicros).toBe(u(12));
    expect(short.picks.map((p) => p.batchId)).toEqual(['a', 'b', 'n']);
  });

  it('may take an expired batch when told to; a batch expiring today is still good', () => {
    const r = pickFefo(batches, u(4), { today: '2026-04-01', allowExpired: true });
    expect(r.picks).toEqual([{ batchId: 'x', qtyMicros: u(4) }]);
    const today = pickFefo(
      [{ batchId: 't', batchNo: 'T', expiryDate: '2026-04-01', availableMicros: u(1) }],
      u(1),
      { today: '2026-04-01' },
    );
    expect(today.picks).toHaveLength(1);
  });
});

describe('serials', () => {
  it('reads a scan or a paste: one per line, comma or space, duplicates reported', () => {
    const r = parseSerials('SN1\nSN2, SN3 SN2;SN4\n\n');
    expect(r.serials).toEqual(['SN1', 'SN2', 'SN3', 'SN4']);
    expect(r.duplicates).toEqual(['SN2']);
    expect(serialCountMatches(r.serials, u(4))).toBe(true);
    expect(serialCountMatches(r.serials, u(3))).toBe(false);
  });

  it('a sale needs each serial in stock; a purchase refuses one that already is', () => {
    const states = new Map([
      ['A', 'in_stock' as const],
      ['B', 'out' as const],
    ]);
    expect(checkSerials(['A', 'B', 'C'], states, 'out')).toEqual({
      unavailable: ['B', 'C'],
      alreadyIn: [],
    });
    expect(checkSerials(['A', 'B', 'C'], states, 'in')).toEqual({
      unavailable: [],
      alreadyIn: ['A'],
    });
  });
});

describe('stock postings', () => {
  it('goods in debit Inventory, goods out credit it, and nothing posts for nothing', () => {
    expect(
      postStock({ direction: 'in', costPaise: 500n, against: 'stockChange', narration: 'x' }),
    ).toEqual([
      { account: 'inventory', debitPaise: 500n, creditPaise: 0n, narration: 'x' },
      { account: 'stockChange', debitPaise: 0n, creditPaise: 500n, narration: 'x' },
    ]);
    expect(
      postStock({ direction: 'out', costPaise: 500n, against: 'adjustments', narration: 'y' }),
    ).toEqual([
      { account: 'adjustments', debitPaise: 500n, creditPaise: 0n, narration: 'y' },
      { account: 'inventory', debitPaise: 0n, creditPaise: 500n, narration: 'y' },
    ]);
    expect(
      postStock({ direction: 'in', costPaise: 0n, against: 'stockChange', narration: '' }),
    ).toEqual([]);
    expect(() =>
      postStock({ direction: 'in', costPaise: -1n, against: 'stockChange', narration: '' }),
    ).toThrow();
  });
});
