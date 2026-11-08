import type { Row } from '@gst/db';
import { receiptBytes } from '@gst/print';
import { describe, expect, it } from 'vitest';

import {
  addToCart,
  buildIndex,
  cartTotalPaise,
  parsePercentBp,
  qtyLabel,
  removeLine,
  resolveCode,
  setLineDiscount,
  setLineQty,
  type CartContext,
} from './model';

const item = (i: number, over: Row = {}): Row => ({
  id: `item-${i}`,
  name: `Item ${i}`,
  sku: `SKU-${String(i).padStart(5, '0')}`,
  barcode: `890${String(1_000_000_000 + i).padStart(10, '0')}`,
  hsn: '1905',
  gst_rate_bp: 1800,
  cess_bp: 0,
  sale_rate_paise: 5000,
  purchase_rate_paise: 3000,
  tax_inclusive: false,
  unit_id: null,
  is_active: true,
  ...over,
});

const ctx: CartContext = {
  businessState: '27',
  composition: false,
  party: null,
  date: '2026-11-02',
};

describe('the item index', () => {
  it('finds an item by barcode, then SKU, ignoring case and spaces, and nothing for an unknown code', () => {
    const idx = buildIndex([item(1), item(2, { barcode: null }), item(3, { is_active: false })]);
    expect(resolveCode(idx, item(1)['barcode'] as string)?.['id']).toBe('item-1');
    expect(resolveCode(idx, ' sku-00002 ')?.['id']).toBe('item-2');
    expect(resolveCode(idx, 'SKU-00001')?.['id']).toBe('item-1');
    expect(resolveCode(idx, 'SKU-00003')).toBeNull();
    expect(resolveCode(idx, '')).toBeNull();
    expect(resolveCode(idx, '0000')).toBeNull();
  });

  it('puts a barcode that is also another item’s SKU on the barcode’s item', () => {
    const idx = buildIndex([
      item(1, { barcode: '12345' }),
      item(2, { sku: '12345', barcode: null }),
    ]);
    expect(resolveCode(idx, '12345')?.['id']).toBe('item-1');
  });
});

describe('the cart', () => {
  it('scanning the same item again adds to its line; another item makes a new line', () => {
    let c = addToCart([], item(1)).cart;
    c = addToCart(c, item(1)).cart;
    c = addToCart(c, item(2), { qtyMicros: 500_000n }).cart;
    c = addToCart(c, item(1)).cart;
    expect(c.map((l) => [l.itemId, l.qtyMicros])).toEqual([
      ['item-1', 3_000_000n],
      ['item-2', 500_000n],
    ]);
    expect(c[0]!.ratePaise).toBe(5000n);
    expect(c[0]!.gstRateBp).toBe(1800);
  });

  it('a discounted line is kept apart from a plain one of the same item', () => {
    let c = addToCart([], item(1)).cart;
    c = setLineDiscount(c, c[0]!.key, 1000, { canApprove: true, maxBp: 0 }).cart;
    c = addToCart(c, item(1)).cart;
    expect(c).toHaveLength(2);
    expect(c[0]!.discountValue).toBe(1000n);
    expect(c[1]!.discountValue).toBe(0n);
  });

  it('serial numbers are one to a unit of one line, and a serial cannot be added twice', () => {
    const phone = item(9, { tracking_mode: 'serial' });
    let r = addToCart([], phone, { serial: 'IMEI1' });
    r = addToCart(r.cart, phone, { serial: 'IMEI2' });
    expect(r.cart).toHaveLength(1);
    expect(r.cart[0]!.serials).toEqual(['IMEI1', 'IMEI2']);
    expect(r.cart[0]!.qtyMicros).toBe(2_000_000n);
    const dup = addToCart(r.cart, phone, { serial: 'IMEI1' });
    expect(dup.duplicateSerial).toBe(true);
    expect(dup.cart[0]!.serials).toHaveLength(2);
    // taking a unit off drops the last serial
    const less = setLineQty(r.cart, r.cart[0]!.key, 1_000_000n);
    expect(less[0]!.serials).toEqual(['IMEI1']);
  });

  it('sets a quantity, and a quantity of zero takes the line off', () => {
    const c = addToCart([], item(1)).cart;
    expect(setLineQty(c, c[0]!.key, 2_500_000n)[0]!.qtyMicros).toBe(2_500_000n);
    expect(setLineQty(c, c[0]!.key, 0n)).toEqual([]);
    expect(removeLine(c, c[0]!.key)).toEqual([]);
  });

  it('parses a discount typed as a percentage', () => {
    expect(parsePercentBp('5')).toBe(500);
    expect(parsePercentBp('7.5%')).toBe(750);
    expect(parsePercentBp('')).toBe(0);
    expect(parsePercentBp('abc')).toBeNull();
    expect(parsePercentBp('1.234')).toBeNull();
    expect(qtyLabel(2_000_000n)).toBe('2');
    expect(qtyLabel(250_000n)).toBe('0.25');
  });
});

describe('discounts follow the cashier’s limit', () => {
  it('lets a cashier discount up to the limit, and an approver any amount', () => {
    const c = addToCart([], item(1)).cart;
    const key = c[0]!.key;
    expect(setLineDiscount(c, key, 500, { canApprove: false, maxBp: 500 }).allowed).toBe(true);
    const refused = setLineDiscount(c, key, 501, { canApprove: false, maxBp: 500 });
    expect(refused.allowed).toBe(false);
    expect(refused.cart[0]!.discountValue).toBe(0n);
    expect(setLineDiscount(c, key, 5000, { canApprove: true, maxBp: 0 }).allowed).toBe(true);
    expect(setLineDiscount(c, key, 1, { canApprove: false, maxBp: 0 }).allowed).toBe(false);
  });
});

describe('what the customer owes comes from the engine', () => {
  it('prices a cart with tax and a discount to the rupee', () => {
    let c = addToCart([], item(1), { qtyMicros: 4_000_000n }).cart; // 200
    c = setLineDiscount(c, c[0]!.key, 1000, { canApprove: true, maxBp: 0 }).cart; // 180 taxable
    expect(cartTotalPaise(c, ctx)).toBe(21_200n); // 180 + 18% = 212.40, rounded off
    expect(cartTotalPaise([], ctx)).toBe(0n);
  });

  it('an out-of-state customer is charged IGST, which does not change the total for the same rate', () => {
    const c = addToCart([], item(1), { qtyMicros: 2_000_000n }).cart;
    const delhi = cartTotalPaise(c, {
      ...ctx,
      party: { id: 'p', name: 'Delhi', state_code: '07' },
    });
    expect(delhi).toBe(cartTotalPaise(c, ctx));
  });
});

describe('speed', () => {
  it('finds an item among 50,000 and puts it on a 30-line cart, priced, well under 100 ms', () => {
    const items = Array.from({ length: 50_000 }, (_, i) => item(i + 1));
    const t0 = performance.now();
    const idx = buildIndex(items);
    const built = performance.now() - t0;
    expect(built).toBeLessThan(2000);
    let cart = [] as ReturnType<typeof addToCart>['cart'];
    for (let i = 1; i <= 30; i++) cart = addToCart(cart, items[i * 7]!).cart;
    const barcode = items[49_000]!['barcode'] as string;
    const start = performance.now();
    const found = resolveCode(idx, barcode)!;
    const next = addToCart(cart, found).cart;
    const total = cartTotalPaise(next, ctx);
    const took = performance.now() - start;
    expect(found['id']).toBe('item-49001');
    expect(total).toBeGreaterThan(0n);
    expect(next).toHaveLength(31);
    expect(took).toBeLessThan(100);
  });

  it('turns a receipt into printer bytes quickly enough for a one-second print', async () => {
    const { PRESETS, samplePrintModel } = await import('@gst/print');
    const model = samplePrintModel();
    const start = performance.now();
    const bytes = receiptBytes(model, PRESETS.classic, {
      cashDrawer: true,
      billQr: true,
      feedLines: 3,
    });
    const took = performance.now() - start;
    expect(bytes.length).toBeGreaterThan(100);
    expect(took).toBeLessThan(200);
  });
});
