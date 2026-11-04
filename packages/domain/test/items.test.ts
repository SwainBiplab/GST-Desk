import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CsvError,
  DEFAULT_UNIT_CODES,
  GST_RATES_BP,
  ITEM_FIELDS,
  PARTY_FIELDS,
  UQC_MASTER,
  compareVersions,
  csvCell,
  detectDelimiter,
  detectMapping,
  gtinCheckDigit,
  headerSignature,
  isUqc,
  itemWarnings,
  manifestMessage,
  missingRequired,
  parseAmountPaise,
  parseBool,
  parseCsv,
  parseHsnCsv,
  parseQtyMicros,
  parseRateBp,
  planBulkEdit,
  planHsnImport,
  readRow,
  returnsUqc,
  rowAsOf,
  sha256Hex,
  toCsv,
  toPrimaryMicros,
  toSavedMapping,
  toSecondaryMicros,
  validateBarcode,
  validateCustomUnit,
  validateItemInput,
  verifyHsnManifest,
  withCheckDigit,
  type BulkItem,
  type HsnDataFile,
  type HsnManifest,
  type HsnRow,
} from '../src';

describe('csv parsing', () => {
  it('reads quotes, doubled quotes, embedded commas and line breaks', () => {
    const r = parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n');
    expect(r.rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'two\nlines'],
    ]);
    expect(r.lines).toEqual([1, 2]);
  });

  it('drops a byte order mark and counts physical lines after quoted breaks', () => {
    const r = parseCsv('﻿name,qty\n"a\nb",1\n\nc,2');
    expect(r.rows[0]).toEqual(['name', 'qty']);
    expect(r.lines).toEqual([1, 2, 5]);
  });

  it('detects semicolon and tab delimiters but ignores delimiters inside quotes', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('"a,b,c";d')).toBe(';');
    expect(parseCsv('a;b\n1,5;2').rows[1]).toEqual(['1,5', '2']);
  });

  it('keeps empty cells, handles a missing final newline and rejects an open quote', () => {
    expect(parseCsv('a,,c\n1,2,').rows).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
    expect(parseCsv('"",x').rows).toEqual([['', 'x']]);
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(CsvError);
    try {
      parseCsv('a,b\n"oops,1');
    } catch (e) {
      expect((e as CsvError).line).toBe(2);
    }
  });
});

describe('csv writing', () => {
  it('escapes formula starters but keeps deliberate negative numbers', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+91 98765')).toBe("'+91 98765");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5', { numeric: true })).toBe('-5');
    expect(toCsv([['=cmd', { numeric: '-1.50' }]])).toBe("﻿'=cmd,-1.50\r\n");
  });
});

describe('number parsing', () => {
  it('reads Indian and western grouping, currency marks and trailing text', () => {
    expect(parseAmountPaise('1,23,456.50')).toBe(12_345_650);
    expect(parseAmountPaise('123,456.5')).toBe(12_345_650);
    expect(parseAmountPaise('₹ 1,200')).toBe(120_000);
    expect(parseAmountPaise('Rs. 99/-')).toBe(9_900);
    expect(parseAmountPaise('INR 10.5')).toBe(1_050);
    expect(parseAmountPaise('12,34,56,789.00')).toBe(12_345_678_900);
    expect(parseAmountPaise('.5')).toBe(50);
    expect(parseAmountPaise('10.500')).toBe(1_050);
  });

  it('refuses what it cannot read without rounding', () => {
    expect(parseAmountPaise('')).toBeUndefined();
    expect(parseAmountPaise('   ')).toBeUndefined();
    expect(parseAmountPaise('abc')).toBeNull();
    expect(parseAmountPaise('1.234')).toBeNull();
    expect(parseAmountPaise('1,2,3')).toBeNull();
    expect(parseAmountPaise('12,34')).toBeNull();
    expect(parseAmountPaise('1.234,56')).toBeNull();
    expect(parseAmountPaise('-5')).toBeNull();
    expect(parseAmountPaise('-5', { allowNegative: true })).toBe(-500);
    expect(parseAmountPaise('(5.00)', { allowNegative: true })).toBe(-500);
    expect(parseAmountPaise('9'.repeat(30))).toBeNull();
  });

  it('reads rates and quantities', () => {
    expect(parseRateBp('18')).toBe(1800);
    expect(parseRateBp('18%')).toBe(1800);
    expect(parseRateBp('1.5 %')).toBe(150);
    expect(parseRateBp('0.25')).toBe(25);
    expect(parseRateBp('18.005')).toBeNull();
    expect(parseQtyMicros('2.5')).toBe(2_500_000);
    expect(parseQtyMicros('1,000')).toBe(1_000_000_000);
    expect(parseQtyMicros('0.0000001')).toBeNull();
  });

  it('reads yes/no words', () => {
    expect(parseBool('Yes')).toBe(true);
    expect(parseBool('n')).toBe(false);
    expect(parseBool('')).toBeUndefined();
    expect(parseBool('maybe')).toBeNull();
  });
});

describe('barcodes', () => {
  it('computes check digits for known codes', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1); // EAN-13 4006381333931
    expect(gtinCheckDigit('03600029145')).toBe(2); // UPC-A 036000291452
    expect(gtinCheckDigit('9638507')).toBe(4); // EAN-8 96385074
    expect(withCheckDigit('890123456789')).toBe('8901234567890');
  });

  it('accepts correct GTINs and names their kind', () => {
    expect(validateBarcode('4006381333931')).toEqual({
      ok: true,
      kind: 'ean13',
      code: '4006381333931',
    });
    expect(validateBarcode(' 036000291452 ')).toEqual({
      ok: true,
      kind: 'upca',
      code: '036000291452',
    });
    expect(validateBarcode('96385074')).toMatchObject({ ok: true, kind: 'ean8' });
    expect(validateBarcode(withCheckDigit('1234567890123'))).toMatchObject({
      ok: true,
      kind: 'gtin14',
    });
  });

  it('rejects a wrong check digit on a GTIN-length code', () => {
    expect(validateBarcode('4006381333932')).toEqual({ ok: false, reason: 'checksum' });
    expect(validateBarcode('96385075')).toEqual({ ok: false, reason: 'checksum' });
  });

  it('treats other lengths and alphanumerics as custom codes', () => {
    expect(validateBarcode('12345')).toMatchObject({ ok: true, kind: 'custom' });
    expect(validateBarcode('SHELF-A/12')).toMatchObject({ ok: true, kind: 'custom' });
    expect(validateBarcode('has space')).toEqual({ ok: false, reason: 'chars' });
    expect(validateBarcode('x'.repeat(49))).toEqual({ ok: false, reason: 'chars' });
    expect(validateBarcode('  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('passes every check digit it generates', () => {
    for (let n = 0; n < 500; n++) {
      const body = String(900_000_000_000 + n * 7919).padStart(12, '0');
      expect(validateBarcode(withCheckDigit(body)).ok).toBe(true);
    }
  });
});

describe('units', () => {
  it('lists unique UQC codes and the default starter units are all valid', () => {
    const codes = UQC_MASTER.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(43);
    for (const c of DEFAULT_UNIT_CODES) expect(isUqc(c)).toBe(true);
  });

  it('maps units to the UQC reported in returns', () => {
    expect(returnsUqc({ code: 'KGS', is_custom: false })).toBe('KGS');
    expect(returnsUqc({ code: 'BAGX', is_custom: true, uqc: 'BAG' })).toBe('BAG');
    expect(returnsUqc({ code: 'TRAY', is_custom: true })).toBe('OTH');
    expect(returnsUqc({ code: 'ODD', is_custom: true, uqc: 'NOPE' })).toBe('OTH');
  });

  it('validates a custom unit', () => {
    expect(validateCustomUnit({ code: 'tray', name: 'Tray', uqc: 'NOS' }, ['NOS'])).toEqual([]);
    expect(validateCustomUnit({ code: 'nos', name: 'x', uqc: 'NOS' }, ['NOS'])).toEqual([
      'duplicate',
    ]);
    expect(validateCustomUnit({ code: 'too long code', name: '', uqc: 'XXX' })).toEqual([
      'code',
      'name',
      'uqc',
    ]);
  });

  it('converts between secondary and primary units with half-away rounding', () => {
    // 1 box = 12 numbers
    expect(toPrimaryMicros(2_500_000n, 12_000_000n)).toBe(30_000_000n);
    expect(toSecondaryMicros(30_000_000n, 12_000_000n)).toBe(2_500_000n);
    expect(toSecondaryMicros(1_000_000n, 3_000_000n)).toBe(333_333n);
    expect(() => toSecondaryMicros(1n, 0n)).toThrow();
  });
});

describe('item validation', () => {
  const ok = { kind: 'goods' as const, name: 'Tea 250g', hsn: '0902', gst_rate_bp: 500 };

  it('accepts a sensible item', () => {
    expect(validateItemInput(ok)).toEqual({});
  });

  it('checks name, barcode, HSN shape and kind, rates and amounts', () => {
    expect(validateItemInput({ ...ok, name: 'x' })).toEqual({ name: 'name' });
    expect(validateItemInput({ ...ok, barcode: '4006381333932' })).toEqual({
      barcode: 'barcode_checksum',
    });
    expect(validateItemInput({ ...ok, hsn: '09' })).toEqual({ hsn: 'hsn' });
    expect(validateItemInput({ ...ok, hsn: '9954' })).toEqual({ hsn: 'hsn_kind' });
    expect(validateItemInput({ ...ok, kind: 'service', hsn: '0902' })).toEqual({ hsn: 'hsn_kind' });
    expect(validateItemInput({ ...ok, kind: 'service', hsn: '995411', gst_rate_bp: 1800 })).toEqual(
      {},
    );
    expect(validateItemInput({ ...ok, gst_rate_bp: 700 })).toEqual({ gst_rate_bp: 'gst_rate' });
    expect(validateItemInput({ ...ok, cess_bp: -1 })).toEqual({ cess_bp: 'cess' });
    expect(validateItemInput({ ...ok, sale_rate_paise: -1 })).toEqual({
      sale_rate_paise: 'amount',
    });
    for (const bp of GST_RATES_BP)
      expect(validateItemInput({ ...ok, gst_rate_bp: bp })).toEqual({});
  });

  it('checks the secondary unit and opening stock', () => {
    expect(
      validateItemInput({
        ...ok,
        unit_id: 'a',
        secondary_unit_id: 'a',
        secondary_factor_micros: 1,
      }),
    ).toEqual({
      secondary_unit_id: 'secondary_same',
    });
    expect(validateItemInput({ ...ok, unit_id: 'a', secondary_unit_id: 'b' })).toEqual({
      secondary_factor_micros: 'secondary_factor',
    });
    expect(
      validateItemInput({ ...ok, kind: 'service', hsn: '9954', track_stock: true }),
    ).toMatchObject({
      track_stock: 'service_stock',
    });
    expect(validateItemInput({ ...ok, opening_stock_micros: 5_000_000 })).toEqual({
      opening_stock_micros: 'opening_qty',
    });
    expect(
      validateItemInput({
        ...ok,
        track_stock: true,
        opening_stock_value_paise: 100,
        opening_stock_micros: 0,
      }),
    ).toEqual({ opening_stock_value_paise: 'opening_value' });
    expect(
      validateItemInput({
        ...ok,
        track_stock: true,
        opening_stock_micros: 5_000_000,
        opening_stock_value_paise: 50_000,
      }),
    ).toEqual({});
  });

  it('warns without blocking', () => {
    expect(itemWarnings({ ...ok }, 1800)).toEqual(['gst_overridden']);
    expect(itemWarnings({ ...ok }, 500)).toEqual([]);
    expect(itemWarnings({ ...ok, sale_rate_paise: 200, mrp_paise: 100 }, null)).toEqual([
      'sale_above_mrp',
    ]);
    expect(itemWarnings({ ...ok, sale_rate_paise: 50, purchase_rate_paise: 100 })).toEqual([
      'sale_below_purchase',
    ]);
    expect(itemWarnings({ kind: 'goods', name: 'Plain' })).toEqual(['no_hsn']);
  });
});

describe('bulk edit planning', () => {
  const item = (over: Partial<BulkItem> = {}): BulkItem => ({
    id: 'i1',
    version: 1,
    name: 'Soap',
    sale_rate_paise: 10_000,
    purchase_rate_paise: 6_000,
    mrp_paise: 12_000,
    gst_rate_bp: 1800,
    cess_bp: 0,
    tags_json: ['soap'],
    ...over,
  });

  it('changes the GST rate and records what it was', () => {
    const [p] = planBulkEdit([item()], { kind: 'gst_rate', rateBp: 1200 });
    expect(p).toMatchObject({
      before: { gst_rate_bp: 1800, cess_bp: 0 },
      after: { gst_rate_bp: 1200, cess_bp: 0 },
    });
    expect(planBulkEdit([item()], { kind: 'gst_rate', rateBp: 1800 })[0]!.skipped).toBe(
      'unchanged',
    );
  });

  it('raises prices by percent with rounding half away from zero', () => {
    const plan = planBulkEdit([item({ sale_rate_paise: 1_005 })], {
      kind: 'price',
      field: 'sale_rate_paise',
      mode: 'percent',
      percentBp: 1000,
    });
    expect(plan[0]!.after).toEqual({ sale_rate_paise: 1_106 }); // 1105.5 rounds up
    const down = planBulkEdit([item({ sale_rate_paise: 1_005 })], {
      kind: 'price',
      field: 'sale_rate_paise',
      mode: 'percent',
      percentBp: -1000,
    });
    expect(down[0]!.after).toEqual({ sale_rate_paise: 905 }); // 904.5 rounds up (away from zero)
  });

  it('adds or subtracts an amount and refuses to go below zero or fill a blank price', () => {
    const add = planBulkEdit([item()], {
      kind: 'price',
      field: 'mrp_paise',
      mode: 'amount',
      deltaPaise: 500,
    });
    expect(add[0]!.after).toEqual({ mrp_paise: 12_500 });
    const neg = planBulkEdit([item({ purchase_rate_paise: 100 })], {
      kind: 'price',
      field: 'purchase_rate_paise',
      mode: 'amount',
      deltaPaise: -200,
    });
    expect(neg[0]!.skipped).toBe('negative');
    const none = planBulkEdit([item({ mrp_paise: null })], {
      kind: 'price',
      field: 'mrp_paise',
      mode: 'percent',
      percentBp: 500,
    });
    expect(none[0]!.skipped).toBe('no_price');
  });

  it('adds and removes tags ignoring case', () => {
    expect(
      planBulkEdit([item()], { kind: 'tag', op: 'add', tag: ' Winter  sale ' })[0]!.after,
    ).toEqual({
      tags_json: ['soap', 'Winter sale'],
    });
    expect(planBulkEdit([item()], { kind: 'tag', op: 'add', tag: 'SOAP' })[0]!.skipped).toBe(
      'unchanged',
    );
    expect(planBulkEdit([item()], { kind: 'tag', op: 'remove', tag: 'Soap' })[0]!.after).toEqual({
      tags_json: [],
    });
    expect(
      planBulkEdit([item({ tags_json: null })], { kind: 'tag', op: 'remove', tag: 'x' })[0]!
        .skipped,
    ).toBe('unchanged');
  });
});

describe('HSN source parsing', () => {
  const csv = [
    'code,description,rate_percent,cess_percent,effective_from',
    '0902,"Tea, whether or not flavoured",5,,2025-09-22',
    '8703,Motor cars,40,17,2025-09-22',
    'abc,Bad code,5,0,2025-09-22',
    '1001,Wheat,five,0,2025-09-22',
    '1006,Rice,0,0,22/09/2025',
    '0902,Duplicate,5,0,2025-09-22',
  ].join('\n');

  it('returns good rows and reports each bad line with its number', () => {
    const r = parseHsnCsv(csv);
    expect(r.rows).toEqual([
      {
        code: '0902',
        description: 'Tea, whether or not flavoured',
        rate_bp: 500,
        cess_bp: 0,
        effective_from: '2025-09-22',
      },
      {
        code: '8703',
        description: 'Motor cars',
        rate_bp: 4000,
        cess_bp: 1700,
        effective_from: '2025-09-22',
      },
    ]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
  });

  it('needs the key columns', () => {
    expect(parseHsnCsv('code,description\n1,2').errors.map((e) => e.message)).toEqual([
      'missing column "rate_percent"',
      'missing column "effective_from"',
    ]);
    expect(parseHsnCsv('').errors).toHaveLength(1);
  });
});

describe('HSN import planning and rate history', () => {
  const row = (over: Partial<HsnRow> = {}): HsnRow => ({
    code: '0902',
    description: 'Tea',
    rate_bp: 500,
    cess_bp: 0,
    effective_from: '2017-07-01',
    ...over,
  });

  it('inserts new codes', () => {
    const p = planHsnImport([], [row(), row({ code: '1001' })]);
    expect(p.inserts).toHaveLength(2);
    expect(p.rateChanges).toEqual([]);
  });

  it('does nothing when the same data is imported again', () => {
    const p = planHsnImport([row()], [row()]);
    expect(p).toMatchObject({ inserts: [], updates: [], rateChanges: [], unchanged: 1 });
  });

  it('keeps the old rate as history when the rate changes', () => {
    const p = planHsnImport([row()], [row({ rate_bp: 1200, effective_from: '2025-09-22' })]);
    expect(p.inserts).toEqual([
      row({ rate_bp: 1200, effective_from: '2025-09-22', effective_to: null }),
    ]);
    expect(p.updates).toEqual([
      { code: '0902', effective_from: '2017-07-01', patch: { effective_to: '2025-09-21' } },
    ]);
    expect(p.rateChanges).toEqual([
      {
        code: '0902',
        description: 'Tea',
        fromBp: 500,
        toBp: 1200,
        fromCessBp: 0,
        toCessBp: 0,
        effectiveFrom: '2025-09-22',
      },
    ]);
  });

  it('does not add a row when a later version repeats the current rate', () => {
    const p = planHsnImport([row()], [row({ effective_from: '2025-09-22' })]);
    expect(p).toMatchObject({ inserts: [], unchanged: 1 });
  });

  it('corrects a row in place when the effective date matches', () => {
    const p = planHsnImport([row()], [row({ rate_bp: 1800 })]);
    expect(p.inserts).toEqual([]);
    expect(p.updates).toEqual([
      { code: '0902', effective_from: '2017-07-01', patch: { rate_bp: 1800 } },
    ]);
    expect(p.rateChanges).toHaveLength(1);
  });

  it('slots an older version into history without disturbing the current row', () => {
    const current = row({ rate_bp: 1200, effective_from: '2025-09-22' });
    const p = planHsnImport([current], [row({ rate_bp: 500, effective_from: '2017-07-01' })]);
    expect(p.inserts).toEqual([
      row({ rate_bp: 500, effective_from: '2017-07-01', effective_to: '2025-09-21' }),
    ]);
    expect(p.updates).toEqual([]);
  });

  it('finds the row in force on a date', () => {
    const history = [
      row({ effective_from: '2017-07-01', effective_to: '2025-09-21' }),
      row({ rate_bp: 1200, effective_from: '2025-09-22' }),
    ];
    expect(rowAsOf(history, '2020-01-01')!.rate_bp).toBe(500);
    expect(rowAsOf(history, '2025-09-22')!.rate_bp).toBe(1200);
    expect(rowAsOf(history, '2016-01-01')).toBeNull();
  });

  it('applies a whole plan idempotently', () => {
    const incoming = [row({ rate_bp: 1200, effective_from: '2025-09-22' }), row({ code: '1001' })];
    const first = planHsnImport([row()], incoming);
    const stored = [
      ...[row()].map((r) => ({
        ...r,
        ...(first.updates.find((u) => u.code === r.code)?.patch ?? {}),
      })),
      ...first.inserts,
    ];
    const second = planHsnImport(stored, incoming);
    expect(second).toMatchObject({ inserts: [], updates: [], rateChanges: [] });
  });
});

describe('versions and signed manifests', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('2026.11.1', '2026.9.3')).toBe(1);
    expect(compareVersions('2026.1', '2026.1.0')).toBe(0);
    expect(compareVersions('2025.12.9', '2026.1.0')).toBe(-1);
  });

  async function make() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const data: HsnDataFile = {
      version: '2026.1.0',
      as_of: '2026-01-01',
      source: 'test',
      rows: [
        {
          code: '0902',
          description: 'Tea',
          rate_bp: 500,
          cess_bp: 0,
          effective_from: '2025-09-22',
        },
      ],
    };
    const dataText = JSON.stringify(data);
    const base = {
      version: data.version,
      as_of: data.as_of,
      count: 1,
      sha256: await sha256Hex(dataText),
    };
    const manifest: HsnManifest = {
      ...base,
      file: 'hsn.json',
      keyId: 'test-key',
      signature: sign(null, Buffer.from(manifestMessage(base)), privateKey).toString('base64'),
    };
    return {
      manifest,
      dataText,
      publicKey: { keyId: 'test-key', publicKeyBase64: raw.toString('base64') },
    };
  }

  it('accepts a correctly signed version', async () => {
    const m = await make();
    expect(await verifyHsnManifest(m)).toEqual({ ok: true });
  });

  it('rejects tampered data, a forged signature, a wrong key and a wrong row count', async () => {
    const m = await make();
    expect(await verifyHsnManifest({ ...m, dataText: m.dataText.replace('500', '0') })).toEqual({
      ok: false,
      reason: 'hash',
    });
    expect(
      await verifyHsnManifest({ ...m, manifest: { ...m.manifest, version: '9.9.9' } }),
    ).toMatchObject({
      ok: false,
    });
    const other = await make();
    expect(
      await verifyHsnManifest({
        ...m,
        manifest: { ...m.manifest, signature: other.manifest.signature },
      }),
    ).toEqual({ ok: false, reason: 'signature' });
    expect(
      await verifyHsnManifest({ ...m, publicKey: { ...m.publicKey, keyId: 'other' } }),
    ).toEqual({
      ok: false,
      reason: 'key',
    });
    expect(await verifyHsnManifest({ ...m, manifest: { ...m.manifest, count: 2 } })).toMatchObject({
      ok: false,
    });
  });
});

describe('import column mapping', () => {
  it('matches common header spellings and uses each column once', () => {
    const headers = [
      'Item Name',
      'HSN/SAC',
      'Selling Price',
      'GST %',
      'UOM',
      'Opening Stock',
      'Junk',
    ];
    const m = detectMapping(headers, ITEM_FIELDS);
    expect(m).toMatchObject({
      name: 0,
      hsn: 1,
      sale_price: 2,
      gst_rate: 3,
      unit: 4,
      opening_qty: 5,
      barcode: null,
    });
    expect(missingRequired(m, ITEM_FIELDS)).toEqual([]);
    expect(missingRequired(detectMapping(['x'], ITEM_FIELDS), ITEM_FIELDS)).toEqual(['name']);
  });

  it('prefers a saved mapping, matched by header text so column order can change', () => {
    const headers = ['Particulars', 'Code', 'Rate'];
    const saved = { name: 'Particulars', sku: 'Code', sale_price: 'Rate' };
    const reordered = ['Rate', 'Particulars', 'Code'];
    expect(detectMapping(reordered, ITEM_FIELDS, saved)).toMatchObject({
      name: 1,
      sku: 2,
      sale_price: 0,
    });
    expect(toSavedMapping(headers, detectMapping(headers, ITEM_FIELDS))).toMatchObject(saved);
    expect(headerSignature(headers)).toBe(headerSignature(reordered));
  });

  it('reads a row through a mapping', () => {
    const m = detectMapping(['Name', 'Phone'], PARTY_FIELDS);
    expect(readRow([' Sharma ', '98'], m)).toMatchObject({
      name: 'Sharma',
      phone: '98',
      gstin: '',
    });
  });
});
