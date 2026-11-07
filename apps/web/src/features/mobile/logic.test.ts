import { describe, expect, it } from 'vitest';

import {
  favouriteItemIds,
  matchBarcode,
  pullOffset,
  pullTriggers,
  qtyLabel,
  recentPartyIds,
  stepQty,
  swipeOutcome,
  tabFor,
  tier1OnPhone,
  upiLink,
} from './logic';

describe('tabs', () => {
  it('lights the tab a page belongs to, and More for everything else', () => {
    expect(tabFor('dashboard')).toBe('home');
    expect(tabFor('sell')).toBe('bill');
    expect(tabFor('parties')).toBe('parties');
    expect(tabFor('inbox')).toBe('inbox');
    expect(tabFor('reports')).toBe('more');
    expect(tabFor('settings')).toBe('more');
    expect(tabFor(null)).toBe('more');
  });
});

describe('quantity stepper', () => {
  const M = 1_000_000n;
  it('steps whole numbers by one and never below one', () => {
    expect(stepQty(2n * M, 1)).toBe(3n * M);
    expect(stepQty(2n * M, -1)).toBe(M);
    expect(stepQty(M, -1)).toBe(M);
  });
  it('rounds a fraction to the next whole number in the direction pressed', () => {
    expect(stepQty(2_500_000n, 1)).toBe(3n * M);
    expect(stepQty(2_500_000n, -1)).toBe(2n * M);
    expect(stepQty(500_000n, -1)).toBe(M);
  });
  it('labels without trailing zeros', () => {
    expect(qtyLabel(2n * M)).toBe('2');
    expect(qtyLabel(2_500_000n)).toBe('2.5');
  });
});

describe('gestures', () => {
  it('a swipe springs back, stays open, or commits by how far it went', () => {
    expect(swipeOutcome(30)).toBe('closed');
    expect(swipeOutcome(-100)).toBe('open');
    expect(swipeOutcome(200)).toBe('commit');
  });
  it('a pull resists after the trigger point', () => {
    expect(pullOffset(-10)).toBe(0);
    expect(pullOffset(40)).toBe(40);
    expect(pullOffset(164)).toBeCloseTo(64 + 35);
    expect(pullTriggers(63)).toBe(false);
    expect(pullTriggers(64)).toBe(true);
  });
});

describe('recents and favourites', () => {
  it('lists parties by their latest document, once each, skipping deleted documents', () => {
    const docs = [
      { party_id: 'a', updated_at: 1, deleted_at: null },
      { party_id: 'b', updated_at: 5, deleted_at: null },
      { party_id: 'a', updated_at: 3, deleted_at: null },
      { party_id: 'c', updated_at: 9, deleted_at: 9 },
      { party_id: null, updated_at: 7, deleted_at: null },
    ];
    expect(recentPartyIds(docs)).toEqual(['b', 'a']);
    expect(recentPartyIds(docs, 1)).toEqual(['b']);
  });
  it('ranks items by how often they were sold', () => {
    expect(
      favouriteItemIds(
        [
          { item_id: 'x', count: 2 },
          { item_id: 'y', count: 9 },
          { item_id: null, count: 50 },
        ],
        5,
      ),
    ).toEqual(['y', 'x']);
  });
  it('matches a barcode exactly, then a SKU case-insensitively', () => {
    const items = [
      { id: '1', barcode: '8901234567890', sku: 'ab-1' },
      { id: '2', barcode: null, sku: 'CEM-50' },
    ];
    expect(matchBarcode(items, '8901234567890')?.['id']).toBe('1');
    expect(matchBarcode(items, 'cem-50')?.['id']).toBe('2');
    expect(matchBarcode(items, ' ')).toBeNull();
  });
});

describe('UPI link', () => {
  it('follows the upi://pay form with the amount in rupees', () => {
    const link = upiLink({
      upiId: 'shop@upi',
      payee: 'Asha Traders',
      amountPaise: 123_450n,
      note: 'INV-0042',
    });
    expect(link).toBe('upi://pay?pa=shop%40upi&pn=Asha+Traders&am=1234.50&cu=INR&tn=INV-0042');
  });
});

describe('where extraction runs', () => {
  it('runs the model on the phone only with WebGPU and a capable device', () => {
    expect(tier1OnPhone({ deviceClass: 'capable', webgpu: true })).toBe(true);
    expect(tier1OnPhone({ deviceClass: 'capable', webgpu: false })).toBe(false);
    expect(tier1OnPhone({ deviceClass: 'baseline', webgpu: true })).toBe(false);
  });
});
