import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEDGE,
  WedgeParser,
  buildZReport,
  cashSuggestions,
  closeVariance,
  discountAllowed,
  expectedCash,
  parseBillCode,
  parseScaleReading,
  settleTenders,
  stripWedge,
  type BillFacts,
} from '../src';

const rs = (n: number) => BigInt(Math.round(n * 100));

/** Type a string key by key, `gap` ms apart, then the ending key. */
function type(
  p: WedgeParser,
  text: string,
  gap: number,
  start = 1000,
  end: string | null = 'Enter',
) {
  let t = start;
  let out = null as ReturnType<WedgeParser['push']>;
  for (const ch of text) {
    out = p.push(ch, t) ?? out;
    t += gap;
  }
  if (end) out = p.push(end, t);
  return out;
}

describe('scanner wedge parsing', () => {
  it('a burst of keys ended by Enter is a scan; the same keys typed slowly are typing', () => {
    expect(type(new WedgeParser(), '8901234567890', 8)).toEqual({
      kind: 'scan',
      text: '8901234567890',
    });
    expect(type(new WedgeParser(), '8901234567890', 180)).toEqual({
      kind: 'typed',
      text: '8901234567890',
    });
  });

  it('one slow gap in the middle makes it typing, and a short code is typing too', () => {
    const p = new WedgeParser();
    let t = 0;
    for (const ch of '8901') p.push(ch, (t += 8));
    p.push('2', (t += 400));
    for (const ch of '345') p.push(ch, (t += 8));
    expect(p.push('Enter', t + 8)).toEqual({ kind: 'typed', text: '89012345' });
    expect(type(new WedgeParser(), '12', 5)).toEqual({ kind: 'typed', text: '12' });
  });

  it('takes a programmed prefix off, and treats text without it as typed', () => {
    const cfg = { ...DEFAULT_WEDGE, prefix: '~' };
    expect(type(new WedgeParser(cfg), '~SKU-0042', 20)).toEqual({ kind: 'scan', text: 'SKU-0042' });
    // even a slow burst is a scan once the prefix says so: the prefix is the evidence
    expect(type(new WedgeParser(cfg), '~SKU-0042', 150)).toEqual({
      kind: 'scan',
      text: 'SKU-0042',
    });
    expect(type(new WedgeParser(cfg), 'SKU-0042', 5)).toEqual({ kind: 'typed', text: 'SKU-0042' });
  });

  it('works with a Tab ending, and with no ending key where a pause ends the code', () => {
    const tab = new WedgeParser({ ...DEFAULT_WEDGE, suffix: 'Tab' });
    expect(type(tab, '12345', 10, 0, 'Tab')).toEqual({ kind: 'scan', text: '12345' });
    // Enter is not this scanner's ending: it is ignored as a key of its own
    expect(new WedgeParser({ ...DEFAULT_WEDGE, suffix: 'Tab' }).push('Enter', 5)).toBeNull();

    const none = new WedgeParser({ ...DEFAULT_WEDGE, suffix: 'none' });
    type(none, '12345', 10, 0, null);
    expect(none.flush(40 + 30)).toBeNull(); // still inside the pause
    expect(none.flush(40 + 100)).toEqual({ kind: 'scan', text: '12345' });
    expect(none.flush(500)).toBeNull();
  });

  it('keeps scans apart and forgets a half-typed code on reset', () => {
    const p = new WedgeParser();
    expect(type(p, '1111', 5, 0)).toEqual({ kind: 'scan', text: '1111' });
    expect(type(p, '2222', 5, 1000)).toEqual({ kind: 'scan', text: '2222' });
    p.push('9', 5000);
    p.reset();
    expect(type(p, '3333', 5, 6000)).toEqual({ kind: 'scan', text: '3333' });
    expect(p.push('Enter', 7000)).toBeNull();
  });

  it('strips a prefix and a suffix from a code that arrived whole', () => {
    expect(stripWedge('~ABC123\r\n', { prefix: '~' })).toBe('ABC123');
    expect(stripWedge('ABC123#', { prefix: '', suffix: '#' })).toBe('ABC123');
    expect(stripWedge('  ABC123 ', { prefix: '~' })).toBe('ABC123');
  });
});

describe('what a scan points at', () => {
  it('reads the invoice number from the invoice QR, or takes a plain number', () => {
    expect(parseBillCode('27AAPFU0939F1ZV|INV/26-27/0042|2026-11-03|1180.00')).toBe(
      'INV/26-27/0042',
    );
    expect(parseBillCode(' INV/26-27/0042 ')).toBe('INV/26-27/0042');
    expect(parseBillCode('27AAPFU0939F1ZV||2026-11-03|1180.00')).toBeNull();
    expect(parseBillCode('   ')).toBeNull();
  });

  it('reads a weighing scale in kilograms or grams, and notes when it is unsettled', () => {
    expect(parseScaleReading('ST,GS,   0.250kg')).toEqual({ kgMicros: 250_000, stable: true });
    expect(parseScaleReading('  1.250 kg')).toEqual({ kgMicros: 1_250_000, stable: true });
    expect(parseScaleReading('W:0,5kg')).toEqual({ kgMicros: 500_000, stable: true });
    expect(parseScaleReading('250 g')).toEqual({ kgMicros: 250_000, stable: true });
    expect(parseScaleReading('US,GS,   0.250kg')).toEqual({ kgMicros: 250_000, stable: false });
    expect(parseScaleReading('hello')).toBeNull();
  });
});

describe('paying a bill over several modes', () => {
  it('cash above the total is change; exact card and UPI leave no change', () => {
    const r = settleTenders(rs(472), [{ mode: 'cash', amountPaise: rs(500) }]);
    expect(r.ok).toBe(true);
    expect(r.changePaise).toBe(rs(28));
    expect(r.applied).toEqual([{ mode: 'cash', amountPaise: rs(472), reference: '' }]);

    const split = settleTenders(rs(1000), [
      { mode: 'upi', amountPaise: rs(400), reference: 'UPI123' },
      { mode: 'card', amountPaise: rs(250), reference: 'AUTH9' },
      { mode: 'cash', amountPaise: rs(400) },
    ]);
    expect(split.ok).toBe(true);
    expect(split.changePaise).toBe(rs(50));
    expect(split.applied.map((a) => [a.mode, a.amountPaise])).toEqual([
      ['upi', rs(400)],
      ['card', rs(250)],
      ['cash', rs(350)],
    ]);
    // what was settled is exactly the total, however the tenders were ordered
    const total = split.applied.reduce((s, a) => s + a.amountPaise, 0n);
    expect(total).toBe(rs(1000));
  });

  it('refuses card and UPI that exceed the total, and says when a bill is short', () => {
    const over = settleTenders(rs(100), [
      { mode: 'upi', amountPaise: rs(80) },
      { mode: 'card', amountPaise: rs(40) },
    ]);
    expect(over.ok).toBe(false);
    expect(over.errors).toContain('over_noncash');

    const short = settleTenders(rs(100), [
      { mode: 'upi', amountPaise: rs(30) },
      { mode: 'cash', amountPaise: rs(50) },
    ]);
    expect(short.ok).toBe(false);
    expect(short.errors).toEqual(['short']);
    expect(short.shortPaise).toBe(rs(20));
    expect(short.changePaise).toBe(0n);

    expect(settleTenders(rs(100), []).errors).toContain('no_tender');
    expect(settleTenders(0n, [{ mode: 'cash', amountPaise: rs(5) }]).errors).toContain(
      'nothing_due',
    );
    expect(settleTenders(rs(10), [{ mode: 'cash', amountPaise: -rs(5) }]).errors).toContain(
      'bad_amount',
    );
  });

  it('two cash tenders share the cash applied, and the change comes off the last', () => {
    const r = settleTenders(rs(150), [
      { mode: 'cash', amountPaise: rs(100) },
      { mode: 'cash', amountPaise: rs(100) },
    ]);
    expect(r.applied.map((a) => a.amountPaise)).toEqual([rs(100), rs(50)]);
    expect(r.changePaise).toBe(rs(50));
  });

  it('property: whatever is tendered, settled plus change equals cash handed over plus the others', () => {
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 400; i++) {
      const due = BigInt(1 + Math.floor(rnd() * 500_000));
      const tenders = (['cash', 'upi', 'card', 'other'] as const)
        .filter(() => rnd() < 0.6)
        .map((mode) => ({ mode, amountPaise: BigInt(1 + Math.floor(rnd() * 400_000)) }));
      const r = settleTenders(due, tenders);
      const handed = tenders.reduce((s, t) => s + t.amountPaise, 0n);
      const applied = r.applied.reduce((s, a) => s + a.amountPaise, 0n);
      if (r.errors.includes('over_noncash')) continue;
      expect(applied + r.changePaise, 'applied + change = handed over').toBe(handed);
      expect(applied + r.shortPaise, 'applied + short = due').toBe(due);
      expect(r.ok).toBe(r.shortPaise === 0n && tenders.length > 0);
      if (r.ok) expect(applied).toBe(due);
    }
  });

  it('suggests the exact amount and the next notes up', () => {
    expect(cashSuggestions(rs(472))).toEqual([rs(472), rs(480), rs(500), rs(600)]);
    expect(cashSuggestions(rs(500))).toEqual([rs(500), rs(600), rs(2000)]);
    expect(cashSuggestions(0n)).toEqual([]);
  });
});

describe('discounts', () => {
  it('anyone who can approve gives any discount; the rest up to the limit; a limit of zero is none', () => {
    expect(discountAllowed({ canApprove: true, discountBp: 5000, maxBp: 0 })).toBe(true);
    expect(discountAllowed({ canApprove: false, discountBp: 500, maxBp: 500 })).toBe(true);
    expect(discountAllowed({ canApprove: false, discountBp: 501, maxBp: 500 })).toBe(false);
    expect(discountAllowed({ canApprove: false, discountBp: 1, maxBp: 0 })).toBe(false);
    expect(discountAllowed({ canApprove: true, discountBp: 10_001, maxBp: 0 })).toBe(false);
    expect(discountAllowed({ canApprove: true, discountBp: -1, maxBp: 0 })).toBe(false);
  });
});

describe('shifts and the Z report', () => {
  it('the drawer should hold the float plus cash sales, less refunds and cash taken out', () => {
    expect(
      expectedCash({
        floatPaise: rs(2000),
        cashSalesPaise: rs(14_350),
        cashRefundsPaise: rs(350),
        cashInPaise: rs(500),
        cashOutPaise: rs(3000),
      }),
    ).toBe(rs(13_500));
  });

  it('records a short, an over and a balanced count', () => {
    expect(closeVariance(rs(13_500), rs(13_450))).toEqual({
      variancePaise: -rs(50),
      status: 'short',
    });
    expect(closeVariance(rs(13_500), rs(13_520))).toEqual({
      variancePaise: rs(20),
      status: 'over',
    });
    expect(closeVariance(rs(13_500), rs(13_500))).toEqual({
      variancePaise: 0n,
      status: 'balanced',
    });
  });

  const sale = (total: number, tenders: BillFacts['tenders']): BillFacts => ({
    kind: 'sale',
    totalPaise: rs(total),
    taxablePaise: rs(total / 1.18),
    cgstPaise: rs((total - total / 1.18) / 2),
    sgstPaise: rs((total - total / 1.18) / 2),
    igstPaise: 0n,
    cessPaise: 0n,
    tenders,
  });

  it('adds up sales and returns by mode, tax and the drawer', () => {
    const bills: BillFacts[] = [
      sale(1180, [{ mode: 'cash', amountPaise: rs(1180) }]),
      sale(590, [
        { mode: 'upi', amountPaise: rs(500) },
        { mode: 'cash', amountPaise: rs(90) },
      ]),
      { ...sale(236, [{ mode: 'cash', amountPaise: rs(236) }]), kind: 'return' },
    ];
    const z = buildZReport(
      bills,
      [
        { kind: 'out', amountPaise: rs(200) },
        { kind: 'in', amountPaise: rs(100) },
      ],
      rs(1000),
    );
    expect(z.salesCount).toBe(2);
    expect(z.returnsCount).toBe(1);
    expect(z.salesPaise).toBe(rs(1770));
    expect(z.returnsPaise).toBe(rs(236));
    expect(z.netPaise).toBe(rs(1534));
    expect(z.byMode.cash).toBe(rs(1180 + 90 - 236));
    expect(z.byMode.upi).toBe(rs(500));
    // net takings by mode add up to net sales
    expect(Object.values(z.byMode).reduce((s, v) => s + v, 0n)).toBe(z.netPaise);
    expect(z.drawer.expectedPaise).toBe(rs(1000 + 1270 - 236 + 100 - 200));
    expect(z.tax.cgstPaise).toBe(z.tax.sgstPaise);
    expect(z.tax.taxablePaise).toBeGreaterThan(0n);
  });

  it('an empty shift reports nothing but the float', () => {
    const z = buildZReport([], [], rs(500));
    expect(z.netPaise).toBe(0n);
    expect(z.drawer.expectedPaise).toBe(rs(500));
  });
});
