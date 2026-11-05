import { describe, expect, it } from 'vitest';

import {
  adjustmentToCount,
  countSheetTemplate,
  isLow,
  isStockPolicy,
  parseCountSheet,
  shortfalls,
  signedQty,
  stockDecision,
  stockEffectOf,
  sumByItem,
  type DocumentType,
  type StockNeed,
} from '../src';

describe('which documents move stock, and which way', () => {
  const cases: [DocumentType, 'in' | 'out' | null][] = [
    ['tax_invoice', 'out'],
    ['bill_of_supply', 'out'],
    ['debit_note', 'out'],
    ['purchase_return', 'out'],
    ['purchase_bill', 'in'],
    ['credit_note', 'in'],
    ['quotation', null],
    ['proforma', null],
    ['receipt_voucher', null],
    ['expense', null],
    ['delivery_challan', null],
  ];
  it.each(cases)('%s moves %s', (type, direction) => {
    expect(stockEffectOf(type)).toBe(direction);
  });

  it('a delivery challan takes stock out only when it is set to', () => {
    expect(stockEffectOf('delivery_challan')).toBeNull();
    expect(stockEffectOf('delivery_challan', { reduceStock: false })).toBeNull();
    expect(stockEffectOf('delivery_challan', { reduceStock: true })).toBe('out');
  });

  it('the setting changes nothing for other documents', () => {
    expect(stockEffectOf('tax_invoice', { reduceStock: false })).toBe('out');
    expect(stockEffectOf('quotation', { reduceStock: true })).toBeNull();
  });

  it('signs a quantity by direction', () => {
    expect(signedQty('out', 3_000_000)).toBe(-3_000_000);
    expect(signedQty('in', 3_000_000)).toBe(3_000_000);
  });
});

describe('negative stock policy', () => {
  const need = (itemId: string, onHandMicros: number, needMicros: number): StockNeed => ({
    itemId,
    name: `Item ${itemId}`,
    onHandMicros,
    needMicros,
  });

  it('adds a document’s lines up per item, ignoring free-text lines', () => {
    const m = sumByItem([
      { itemId: 'a', qtyMicros: 2_000_000 },
      { itemId: 'b', qtyMicros: 1_000_000 },
      { itemId: 'a', qtyMicros: 3_500_000 },
      { itemId: null, qtyMicros: 9_000_000 },
    ]);
    expect([...m]).toEqual([
      ['a', 5_500_000],
      ['b', 1_000_000],
    ]);
  });

  it('finds only the items that would go below zero', () => {
    const s = shortfalls([
      need('a', 5_000_000, 5_000_000),
      need('b', 2_000_000, 2_500_000),
      need('c', 0, 0),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ itemId: 'b', afterMicros: -500_000 });
  });

  it('taking out exactly what is there is fine; one more unit is not', () => {
    expect(shortfalls([need('a', 4_000_000, 4_000_000)])).toEqual([]);
    expect(shortfalls([need('a', 4_000_000, 4_000_001)])).toHaveLength(1);
  });

  it('allow warns, block refuses, and neither says anything when stock is enough', () => {
    const short = [need('a', 1_000_000, 3_000_000)];
    expect(stockDecision('allow', short).action).toBe('warn');
    expect(stockDecision('block', short).action).toBe('block');
    expect(stockDecision('block', [need('a', 5_000_000, 3_000_000)])).toEqual({ action: 'ok' });
    // already negative and taking out more is still a shortfall
    expect(stockDecision('block', [need('a', -1_000_000, 1_000_000)]).action).toBe('block');
  });

  it('knows a policy when it sees one', () => {
    expect(isStockPolicy('allow')).toBe(true);
    expect(isStockPolicy('block')).toBe(true);
    expect(isStockPolicy('warn')).toBe(false);
    expect(isStockPolicy(undefined)).toBe(false);
  });

  it('low means below the reorder level, and a level of zero means none is set', () => {
    expect(isLow(4_000_000, 5_000_000)).toBe(true);
    expect(isLow(5_000_000, 5_000_000)).toBe(false);
    expect(isLow(0, 0)).toBe(false);
    expect(isLow(-1_000_000, 0)).toBe(false);
  });
});

describe('count sheets', () => {
  it('reads a sheet by SKU: skips blank counts, keeps the quantity in millionths', () => {
    const s = parseCountSheet(
      'SKU,Item,System quantity,Counted quantity\nA-1,Widget,10,8\nA-2,Gadget,5,\nA-3,Gizmo,0,2.5\n',
    );
    expect(s.errors).toEqual([]);
    expect(s.rows).toEqual([
      { by: 'sku', key: 'A-1', countedMicros: 8_000_000, line: 2 },
      { by: 'sku', key: 'A-3', countedMicros: 2_500_000, line: 4 },
    ]);
  });

  it('finds the item by barcode or name when there is no SKU column, and takes other count headings', () => {
    expect(parseCountSheet('Barcode,Physical\n8901234567890,4\n').rows[0]).toMatchObject({
      by: 'barcode',
      countedMicros: 4_000_000,
    });
    expect(parseCountSheet('Item name;Qty\nWidget;7\n').rows[0]).toMatchObject({
      by: 'name',
      key: 'Widget',
      countedMicros: 7_000_000,
    });
  });

  it('copes with Indian number grouping, a byte order mark and quoted names', () => {
    const s = parseCountSheet('﻿SKU,Item,Counted\nA-1,"Nut, bolt and washer","1,250"\n');
    expect(s.rows[0]).toMatchObject({ key: 'A-1', countedMicros: 1_250_000_000 });
  });

  it('reports a row it cannot read with its line, and does not stop', () => {
    const s = parseCountSheet('SKU,Counted\nA-1,abc\nA-2,-3\n,5\nA-4,6\nA-4,7\nA-5,2\n');
    expect(s.errors).toEqual([
      { line: 2, reason: 'bad_quantity' },
      { line: 3, reason: 'negative' },
      { line: 4, reason: 'no_item' },
      { line: 6, reason: 'duplicate' },
    ]);
    expect(s.rows.map((r) => r.key)).toEqual(['A-4', 'A-5']);
  });

  it('says what is missing when the headings are wrong', () => {
    expect(parseCountSheet('Foo,Bar\n1,2\n').errors[0]?.reason).toBe('no_item');
    expect(parseCountSheet('SKU,Bar\nA,2\n').errors[0]?.reason).toBe('bad_quantity');
    expect(parseCountSheet('')).toEqual({ rows: [], errors: [] });
  });

  it('makes the sheet to fill in, and the sheet reads back', () => {
    const csv = countSheetTemplate(
      [
        { sku: 'A-1', name: 'Widget', onHandMicros: 10_000_000 },
        { sku: 'A-2', name: '=cmd', onHandMicros: 2_500_000 },
      ],
      (m) => String(m / 1_000_000),
    );
    expect(csv).toContain('SKU,Item,System quantity,Counted quantity');
    expect(csv).toContain("'=cmd"); // a name that looks like a formula is neutralised
    // blank counts mean "not counted", so a fresh sheet reads as nothing counted
    expect(parseCountSheet(csv).rows).toEqual([]);
    expect(parseCountSheet(csv).errors).toEqual([]);
  });

  it('works out the difference to book', () => {
    expect(adjustmentToCount(10_000_000, 8_000_000)).toBe(-2_000_000);
    expect(adjustmentToCount(-1_000_000, 0)).toBe(1_000_000);
    expect(adjustmentToCount(3_000_000, 3_000_000)).toBe(0);
  });
});
