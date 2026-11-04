import { withCheckDigit } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import { ITEM_CSV_HEADERS, itemsCsv } from './csv';
import {
  draftToValues,
  emptyItemDraft,
  matchedWords,
  parseTagList,
  rowToDraft,
  serverErrorsToForm,
  trimZeros,
  validateItem,
  type ItemDraft,
} from './form';
import { itemDraftFromRow, unitIndex } from './import-items';

const draft = (over: Partial<ItemDraft> = {}): ItemDraft =>
  emptyItemDraft({ name: 'Tea 250g', ...over });

describe('item validation', () => {
  it('accepts a minimal item and reports a missing name', () => {
    expect(validateItem(draft())).toEqual({});
    expect(validateItem(draft({ name: ' ' }))).toEqual({ name: 'name' });
  });

  it('reports unreadable numbers under their own field', () => {
    expect(
      validateItem(
        draft({ salePrice: 'abc', purchasePrice: '1.234', mrp: '-5', gstRate: 'x', cess: '1,2' }),
      ),
    ).toEqual({
      salePrice: 'amount',
      purchasePrice: 'amount',
      mrp: 'amount',
      gstRate: 'gst_rate',
      cess: 'cess',
    });
  });

  it('reads Indian number styles', () => {
    expect(
      validateItem(
        draft({ salePrice: '₹ 1,23,456.50', purchasePrice: 'Rs. 99/-', gstRate: '18%' }),
      ),
    ).toEqual({});
  });

  it('applies the domain rules and maps them to form fields', () => {
    const code = withCheckDigit('890123456789');
    expect(validateItem(draft({ barcode: code }))).toEqual({});
    expect(validateItem(draft({ barcode: code.slice(0, 12) + '9' }))).toEqual({
      barcode: 'barcode_checksum',
    });
    expect(validateItem(draft({ hsn: '99' }))).toEqual({ hsn: 'hsn' });
    expect(validateItem(draft({ kind: 'service', hsn: '0902' }))).toEqual({ hsn: 'hsn_kind' });
    expect(validateItem(draft({ gstRate: '7' }))).toEqual({ gstRate: 'gst_rate' });
    expect(
      validateItem(draft({ unitId: 'a', secondaryUnitId: 'a', secondaryFactor: '2' })),
    ).toEqual({
      secondaryUnitId: 'secondary_same',
    });
    expect(validateItem(draft({ secondaryUnitId: 'b', unitId: 'a' }))).toEqual({
      secondaryFactor: 'secondary_factor',
    });
    expect(validateItem(draft({ trackStock: true, openingValue: '500' }))).toEqual({
      openingValue: 'opening_value',
    });
    expect(validateItem(draft({ openingQty: '5' }))).toEqual({ openingQty: 'opening_qty' });
  });

  it('maps repository errors to form fields', () => {
    expect(
      serverErrorsToForm({ sku: 'duplicate_sku', unit_id: 'unit', gst_rate_bp: 'gst_rate' }),
    ).toEqual({
      sku: 'duplicate_sku',
      unitId: 'unit',
      gstRate: 'gst_rate',
    });
  });
});

describe('item values', () => {
  it('turns typed text into paise, basis points and micro-units', () => {
    const v = draftToValues(
      draft({
        name: '  Tea 250g ',
        sku: ' T-1 ',
        hsn: '0902',
        gstRate: '5',
        cess: '1.5',
        salePrice: '120.50',
        purchasePrice: '90',
        mrp: '130',
        taxInclusive: true,
        trackStock: true,
        openingQty: '12.5',
        openingValue: '1,125',
        reorder: '3',
        tags: 'grocery, Tea, grocery',
      }),
    );
    expect(v).toMatchObject({
      name: 'Tea 250g',
      sku: 'T-1',
      hsn: '0902',
      gst_rate_bp: 500,
      cess_bp: 150,
      sale_rate_paise: 12_050,
      purchase_rate_paise: 9_000,
      mrp_paise: 13_000,
      tax_inclusive: true,
      track_stock: true,
      opening_stock_micros: 12_500_000,
      opening_stock_value_paise: 112_500,
      min_stock_micros: 3_000_000,
      tags_json: ['grocery', 'Tea'],
    });
  });

  it('uses zero for blank prices and null for a blank MRP, and never tracks stock for a service', () => {
    const v = draftToValues(draft({ kind: 'service', hsn: '9954', trackStock: true }));
    expect(v).toMatchObject({
      sale_rate_paise: 0,
      purchase_rate_paise: 0,
      mrp_paise: null,
      track_stock: false,
      sku: null,
    });
  });

  it('refuses to convert a draft with unreadable numbers', () => {
    expect(() => draftToValues(draft({ salePrice: 'abc' }))).toThrow(RangeError);
  });

  it('round-trips through a stored row', () => {
    const original = draft({
      sku: 'RT-1',
      barcode: '12345',
      hsn: '0902',
      gstRate: '1.5',
      cess: '12',
      salePrice: '99.90',
      mrp: '120.00',
      secondaryUnitId: 'u2',
      unitId: 'u1',
      secondaryFactor: '12',
      trackStock: true,
      openingQty: '2.5',
      openingValue: '250.00',
      reorder: '1',
      tags: 'a, b',
      isActive: false,
      description: 'note',
    });
    const back = rowToDraft(draftToValues(original));
    expect(back).toMatchObject({ ...original, purchasePrice: '' });
  });

  it('trims zeros and tags', () => {
    expect(trimZeros('18.00')).toBe('18');
    expect(trimZeros('1.50')).toBe('1.5');
    expect(trimZeros('100')).toBe('100');
    expect(parseTagList(' a, B ,a,, b ')).toEqual(['a', 'B']);
  });
});

describe('HSN suggestion reasons', () => {
  it('names the words that matched, allowing simple plurals', () => {
    expect(matchedWords('steel pipes', 'Tubes, pipes and hoses of steel')).toEqual([
      'steel',
      'pipes',
    ]);
    expect(matchedWords('pipe', 'Tubes, pipes and hoses')).toEqual(['pipe']);
    expect(matchedWords('banana', 'Cheese and curd')).toEqual([]);
  });
});

describe('item export', () => {
  const unitCodes = new Map([['u1', 'NOS']]);
  it('writes the headers the import recognises, plain numbers and escaped text', () => {
    const csv = itemsCsv(
      [
        {
          name: '=HYPERLINK("x")',
          kind: 'goods',
          sku: 'A-1',
          barcode: null,
          hsn: '0902',
          unit_id: 'u1',
          sale_rate_paise: 12_050,
          purchase_rate_paise: 0,
          mrp_paise: null,
          gst_rate_bp: 150,
          cess_bp: 0,
          tax_inclusive: true,
          opening_stock_micros: 2_500_000,
          opening_stock_value_paise: 0,
          min_stock_micros: 0,
          tags_json: ['x', 'y'],
          is_active: false,
        },
      ],
      unitCodes,
    ).slice(1);
    const [head, row] = csv.trim().split('\r\n');
    expect(head).toBe(ITEM_CSV_HEADERS.join(','));
    expect(row).toBe(
      `"'=HYPERLINK(""x"")",goods,A-1,,0902,NOS,120.50,0.00,,1.5,0,Yes,2.5,0.00,,"x, y",No`,
    );
  });
});

describe('item import rows', () => {
  const units = unitIndex([
    { id: 'u-nos', code: 'NOS', name: 'Numbers' },
    { id: 'u-kg', code: 'KGS', name: 'Kilograms' },
  ]);
  const base = {
    name: 'Tea',
    kind: '',
    sku: '',
    barcode: '',
    hsn: '',
    unit: '',
    sale_price: '',
    purchase_price: '',
    mrp: '',
    gst_rate: '',
    cess: '',
    tax_inclusive: '',
    opening_qty: '',
    opening_value: '',
    reorder: '',
    tags: '',
    active: '',
  };

  it('finds units by code or name, ignoring case', () => {
    expect(itemDraftFromRow({ ...base, unit: 'kilograms' }, units).draft.unitId).toBe('u-kg');
    expect(itemDraftFromRow({ ...base, unit: 'nos' }, units).draft.unitId).toBe('u-nos');
    expect(itemDraftFromRow({ ...base, unit: 'bags' }, units).problems).toEqual([
      { field: 'unit', code: 'unit_unknown' },
    ]);
  });

  it('decides goods or service from the type column or a SAC code', () => {
    expect(itemDraftFromRow({ ...base, kind: 'Services' }, units).draft.kind).toBe('service');
    expect(itemDraftFromRow({ ...base, hsn: '9954 11' }, units).draft.kind).toBe('service');
    expect(itemDraftFromRow({ ...base, hsn: '0902' }, units).draft.kind).toBe('goods');
    expect(itemDraftFromRow({ ...base, kind: 'widget' }, units).problems).toEqual([
      { field: 'kind', code: 'kind' },
    ]);
  });

  it('reads yes/no columns and turns an opening quantity into tracked stock', () => {
    const r = itemDraftFromRow(
      { ...base, tax_inclusive: 'Yes', active: 'no', opening_qty: '5' },
      units,
    );
    expect(r.draft).toMatchObject({
      taxInclusive: true,
      isActive: false,
      trackStock: true,
      openingQty: '5',
    });
    expect(itemDraftFromRow({ ...base, active: 'maybe' }, units).problems).toEqual([
      { field: 'active', code: 'bool' },
    ]);
    expect(
      itemDraftFromRow({ ...base, kind: 'service', opening_qty: '5' }, units).draft.trackStock,
    ).toBe(false);
  });
});
