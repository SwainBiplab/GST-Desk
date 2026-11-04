import { planBulkEdit, withCheckDigit, type BulkItem, type HsnRow } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { AuditRepo, BusinessRepo, createOrganisation } from './aggregates';
import { BaseRepo, ConflictError, ImportCancelled, RuleError, type Ctx } from './base';
import { searchHsn } from './hsn';
import { importHsnVersion, listHsnVersions, lookupHsn } from './hsn-master';
import { ImportMappingRepo, ItemRepo, ItemValidationError, UnitRepo } from './items';

async function newTenant(d: Database, name = 'Demo'): Promise<Ctx> {
  const org = await createOrganisation(d, `Org ${name}`);
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev-1' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: name, state_code: '27' });
  return { ...base, businessId: biz['id'] };
}

const hsn = (over: Partial<HsnRow> = {}): HsnRow => ({
  code: '0902',
  description: 'Tea, whether or not flavoured',
  rate_bp: 500,
  cess_bp: 0,
  effective_from: '2017-07-01',
  ...over,
});

const MASTER_V1: HsnRow[] = [
  hsn(),
  hsn({ code: '1001', description: 'Wheat and meslin', rate_bp: 0 }),
  hsn({ code: '3304', description: 'Beauty or make-up preparations', rate_bp: 1800 }),
  hsn({ code: '9954', description: 'Construction services', rate_bp: 1800 }),
];

async function ids(items: ItemRepo, ctx: Ctx) {
  return (await items.list(ctx)).map((r) => r['id'] as string);
}

describe.each(DIALECTS)('items (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let items: ItemRepo;
  let units: UnitRepo;
  let nos: string;

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
    items = new ItemRepo(d);
    units = new UnitRepo(d);
    nos = (await units.list(ctx)).find((u) => u['code'] === 'NOS')!['id'];
    await importHsnVersion(d, { version: '2026.1.0', as_of: '2026-01-01' }, MASTER_V1);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('creates an item, trims text, stores blanks as null and follows the HSN master', async () => {
    const it = await items.create(ctx, {
      name: '  Tea 250g ',
      sku: ' T-250 ',
      barcode: '',
      hsn: '0902',
      gst_rate_bp: 500,
      unit_id: nos,
      sale_rate_paise: 12_000,
    });
    expect(it).toMatchObject({
      name: 'Tea 250g',
      sku: 'T-250',
      barcode: null,
      gst_rate_overridden: false,
      is_active: true,
      tax_inclusive: false,
    });
  });

  it('flags an item whose rate differs from the master, and clears the flag when it matches', async () => {
    const it = await items.create(ctx, { name: 'Odd tea', hsn: '0902', gst_rate_bp: 1200 });
    expect(it['gst_rate_overridden']).toBe(true);
    const fixed = await items.update(ctx, it['id'], { gst_rate_bp: 500 }, it['version']);
    expect(fixed['gst_rate_overridden']).toBe(false);
    const nohsn = await items.create(ctx, { name: 'No code item', gst_rate_bp: 1200 });
    expect(nohsn['gst_rate_overridden']).toBe(false);
  });

  it('resolves a 6 or 8 digit code through its 4 digit heading', async () => {
    const it = await items.create(ctx, { name: 'Tea bags', hsn: '09024010', gst_rate_bp: 1800 });
    expect(it['gst_rate_overridden']).toBe(true);
  });

  it('rejects invalid items with field codes', async () => {
    const bad = await items
      .create(ctx, { name: 'x', barcode: '4006381333932', hsn: '99', gst_rate_bp: 700 })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ItemValidationError);
    expect((bad as ItemValidationError).fields).toEqual({
      name: 'name',
      barcode: 'barcode_checksum',
      hsn: 'hsn',
      gst_rate_bp: 'gst_rate',
    });
    expect(bad).toBeInstanceOf(RuleError);
  });

  it('keeps SKU and barcode unique among live items, and frees them on delete', async () => {
    const code = withCheckDigit('890555000111');
    const a = await items.create(ctx, { name: 'Alpha', sku: 'DUP-1', barcode: code });
    await expect(items.create(ctx, { name: 'Beta', sku: 'DUP-1' })).rejects.toMatchObject({
      fields: { sku: 'duplicate_sku' },
    });
    await expect(items.create(ctx, { name: 'Gamma', barcode: code })).rejects.toMatchObject({
      fields: { barcode: 'duplicate_barcode' },
    });
    expect((await items.findClashes(ctx, { sku: 'DUP-1', barcode: code })).sku?.['id']).toBe(
      a['id'],
    );
    // editing the owner is fine, and it can keep its own code
    await items.update(ctx, a['id'], { name: 'Alpha 2', sku: 'DUP-1' }, a['version']);
    await items.softDelete(ctx, a['id'], a['version'] + 1);
    await expect(
      items.create(ctx, { name: 'Beta', sku: 'DUP-1', barcode: code }),
    ).resolves.toBeTruthy();
  });

  it('also backs uniqueness with a database index', async () => {
    const base = { name: 'Raw', sku: 'RAW-1' };
    await new BaseRepo(d, 'items').create(ctx, base);
    await expect(new BaseRepo(d, 'items').create(ctx, base)).rejects.toThrow();
  });

  it('allows the same SKU in another business', async () => {
    const other = await newTenant(d, 'Other');
    await expect(
      new ItemRepo(d).create(other, { name: 'Same sku', sku: 'RAW-1' }),
    ).resolves.toBeTruthy();
  });

  it('refuses a unit that belongs to another business', async () => {
    const other = await newTenant(d, 'Other 2');
    const foreign = (await new UnitRepo(d).list(other))[0]!['id'];
    await expect(items.create(ctx, { name: 'Leaky', unit_id: foreign })).rejects.toMatchObject({
      fields: { unit_id: 'unit' },
    });
  });

  it('validates only what an edit changes, so older data does not block unrelated edits', async () => {
    const raw = await new BaseRepo(d, 'items').create(ctx, {
      name: 'Legacy',
      kind: 'service',
      hsn: '0902',
    });
    const edited = await items.update(ctx, raw['id'], { sale_rate_paise: 500 }, raw['version']);
    expect(edited['sale_rate_paise']).toBe(500);
    await expect(
      items.update(ctx, raw['id'], { hsn: '12' }, edited['version']),
    ).rejects.toBeInstanceOf(ItemValidationError);
  });

  it('posts opening stock as a movement at the opening value', async () => {
    const it = await items.create(
      ctx,
      {
        name: 'Stocked',
        track_stock: true,
        opening_stock_micros: 4_000_000,
        opening_stock_value_paise: 100_000,
        purchase_rate_paise: 1,
      },
      { openingDate: '2026-04-01' },
    );
    const moves = await new BaseRepo(d, 'stock_movements').list(ctx);
    const m = moves.find((x) => x['item_id'] === it['id'])!;
    expect(m).toMatchObject({
      kind: 'in',
      qty_micros: 4_000_000,
      rate_paise: 25_000,
      date: '2026-04-01',
    });
    await expect(
      items.create(ctx, { name: 'No tracking', opening_stock_micros: 1_000_000 }),
    ).rejects.toMatchObject({ fields: { opening_stock_micros: 'opening_qty' } });
  });

  it('searches by name, SKU, barcode and HSN', async () => {
    const it = await items.create(ctx, {
      name: 'Quicksilver widget',
      sku: 'QS-77',
      hsn: '3304',
      gst_rate_bp: 1800,
    });
    for (const q of ['quicksilver', 'QS-77', 'widg', '3304']) {
      expect((await items.search(ctx, q)).map((r) => r['id'])).toContain(it['id']);
    }
  });

  it('keeps an audit record of every create and update', async () => {
    const it = await items.create(ctx, { name: 'Audited item' });
    await items.update(ctx, it['id'], { sale_rate_paise: 900 }, it['version']);
    const log = await new AuditRepo(d).forRow(ctx, 'items', it['id']);
    expect(log.map((l) => l['action']).sort()).toEqual(['insert', 'update']);
  });
});

describe.each(DIALECTS)('HSN master versions (%s)', (dialect) => {
  let d: Database;
  beforeAll(async () => {
    d = await openTestDb(dialect);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('imports once, records the version and ignores a repeat', async () => {
    const first = await importHsnVersion(
      d,
      { version: '2026.1.0', as_of: '2026-01-01', sha256: 'abc' },
      MASTER_V1,
    );
    expect(first).toMatchObject({ skipped: false, inserted: 4, updated: 0 });
    const again = await importHsnVersion(
      d,
      { version: '2026.1.0', as_of: '2026-01-01' },
      MASTER_V1,
    );
    expect(again.skipped).toBe(true);
    const versions = await listHsnVersions(d);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: '2026.1.0', row_count: 4, as_of: '2026-01-01' });
  });

  it('keeps rate history when a later version changes a rate', async () => {
    const next = await importHsnVersion(d, { version: '2026.2.0', as_of: '2026-02-01' }, [
      hsn({ rate_bp: 1200, effective_from: '2026-03-01' }),
      ...MASTER_V1.slice(1).map((r) => ({ ...r, effective_from: '2026-03-01' })),
    ]);
    expect(next.rateChanges).toEqual([
      expect.objectContaining({
        code: '0902',
        fromBp: 500,
        toBp: 1200,
        effectiveFrom: '2026-03-01',
      }),
    ]);
    expect(next).toMatchObject({ inserted: 1 });
    expect((await lookupHsn(d, '0902', '2026-02-28'))!.rate_bp).toBe(500);
    expect((await lookupHsn(d, '0902', '2026-03-01'))!.rate_bp).toBe(1200);
    expect((await lookupHsn(d, '09021090', '2026-03-01'))!.code).toBe('0902');
    expect(await lookupHsn(d, '0902', '2015-01-01')).toBeNull();
    expect(await lookupHsn(d, '7777')).toBeNull();
  });

  it('searches current descriptions after an import', async () => {
    const hits = await searchHsn(d, 'tea flavoured', { asOf: '2026-04-01' });
    expect(hits[0]).toMatchObject({ code: '0902', rate_bp: 1200 });
  });
});

describe.each(DIALECTS)('rate change assistant (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let items: ItemRepo;
  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
    items = new ItemRepo(d);
    await importHsnVersion(d, { version: '2025.1.0', as_of: '2025-01-01' }, MASTER_V1);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('lists items that follow the master, offers the new rate, and skips deliberate overrides', async () => {
    const follows = await items.create(ctx, { name: 'Follows', hsn: '0902', gst_rate_bp: 500 });
    await items.create(ctx, { name: 'Override', hsn: '0902', gst_rate_bp: 1800 });
    await items.create(ctx, { name: 'Unrelated', hsn: '1001', gst_rate_bp: 0 });
    expect(await items.rateChanges(ctx, '2026-06-01')).toEqual([]);

    await importHsnVersion(d, { version: '2026.6.0', as_of: '2026-05-01' }, [
      hsn({ rate_bp: 1800, effective_from: '2026-06-01' }),
    ]);
    const due = await items.rateChanges(ctx, '2026-06-02');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      id: follows['id'],
      oldRateBp: 500,
      newRateBp: 1800,
      effectiveFrom: '2026-06-01',
      due: true,
    });
    const upcoming = await items.rateChanges(ctx, '2026-05-15');
    expect(upcoming[0]).toMatchObject({ due: false, effectiveFrom: '2026-06-01' });
  });

  it('applies a rate change through a bulk edit, updates the flag and undoes cleanly', async () => {
    const [change] = await items.rateChanges(ctx, '2026-06-02');
    const plan = [
      {
        id: change!.id,
        version: change!.version,
        name: change!.name,
        before: { gst_rate_bp: change!.oldRateBp, cess_bp: change!.oldCessBp },
        after: { gst_rate_bp: change!.newRateBp, cess_bp: change!.newCessBp },
      },
    ];
    const batch = await items.applyBulkEdit(ctx, plan);
    const after = (await items.get(ctx, change!.id))!;
    expect(after).toMatchObject({ gst_rate_bp: 1800, gst_rate_overridden: false });
    expect(await items.rateChanges(ctx, '2026-06-02')).toEqual([]);

    const undone = await items.undoBulkEdit(ctx, batch);
    expect(undone).toEqual({ reverted: 1, skipped: 0 });
    expect((await items.get(ctx, change!.id))!['gst_rate_bp']).toBe(500);
  });
});

describe.each(DIALECTS)('bulk edit (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let items: ItemRepo;
  let idList: string[];

  const asBulk = (r: Record<string, any>): BulkItem => r as unknown as BulkItem;
  const load = async () => (await items.getMany(ctx, idList)).map(asBulk);

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
    items = new ItemRepo(d);
    for (let i = 0; i < 5; i++) {
      await items.create(ctx, {
        name: `Bulk ${i}`,
        sale_rate_paise: 10_000 + i * 100,
        gst_rate_bp: 1800,
      });
    }
    idList = await ids(items, ctx);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('applies a percent price change to every selected item and reports it in the audit log', async () => {
    const plan = planBulkEdit(await load(), {
      kind: 'price',
      field: 'sale_rate_paise',
      mode: 'percent',
      percentBp: 1000,
    });
    const batch = await items.applyBulkEdit(ctx, plan);
    expect(batch.entries).toHaveLength(5);
    const prices = (await load()).map((r) => r.sale_rate_paise).sort((a, b) => a! - b!);
    expect(prices).toEqual([11_000, 11_110, 11_220, 11_330, 11_440]);
    const log = await new AuditRepo(d).recent(ctx, 1000);
    expect(log.filter((l) => l['table_name'] === 'items' && l['action'] === 'update')).toHaveLength(
      5,
    );

    expect(await items.undoBulkEdit(ctx, batch)).toEqual({ reverted: 5, skipped: 0 });
    expect((await load()).map((r) => r.sale_rate_paise).sort((a, b) => a! - b!)).toEqual([
      10_000, 10_100, 10_200, 10_300, 10_400,
    ]);
  });

  it('leaves everything untouched if one item changed after the preview', async () => {
    const plan = planBulkEdit(await load(), { kind: 'gst_rate', rateBp: 1200 });
    const victim = (await items.get(ctx, idList[2]!))!;
    await items.update(ctx, victim['id'], { name: 'Edited meanwhile' }, victim['version']);
    await expect(items.applyBulkEdit(ctx, plan)).rejects.toBeInstanceOf(ConflictError);
    expect((await load()).every((r) => r.gst_rate_bp === 1800)).toBe(true);
  });

  it('does not undo over an edit made after the bulk change', async () => {
    const plan = planBulkEdit(await load(), { kind: 'tag', op: 'add', tag: 'sale' });
    const batch = await items.applyBulkEdit(ctx, plan);
    const one = (await items.get(ctx, idList[0]!))!;
    await items.update(ctx, one['id'], { sale_rate_paise: 1 }, one['version']);
    expect(await items.undoBulkEdit(ctx, batch)).toEqual({ reverted: 4, skipped: 1 });
    expect((await items.get(ctx, idList[0]!))!['tags_json']).toEqual(['sale']);
    expect((await items.get(ctx, idList[1]!))!['tags_json']).toBeNull();
  });
});

describe.each(DIALECTS)('bulk create (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let items: ItemRepo;
  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
    items = new ItemRepo(d);
    await importHsnVersion(d, { version: '2026.1.0', as_of: '2026-01-01' }, MASTER_V1);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Imported ${from + i}`,
      sku: `IMP-${from + i}`,
      hsn: '0902',
      gst_rate_bp: from + i === 0 ? 1200 : 500,
      sale_rate_paise: 1_000 + i,
      tags_json: ['imported'],
    }));

  it('creates many items, audits each, indexes them for search and reports progress', async () => {
    const seen: number[] = [];
    const r = await items.bulkCreate(ctx, rows(450), {
      chunk: 100,
      onProgress: (done) => void seen.push(done),
    });
    expect(r.created).toBe(450);
    expect(seen).toEqual([100, 200, 300, 400, 450]);
    expect((await items.list(ctx)).length).toBe(450);
    expect((await items.search(ctx, 'IMP-449')).length).toBe(1);
    const log = await new AuditRepo(d).recent(ctx, 5000);
    expect(log.filter((l) => l['table_name'] === 'items' && l['action'] === 'insert')).toHaveLength(
      450,
    );
    const flagged = (await items.list(ctx)).filter((i) => i['gst_rate_overridden']);
    expect(flagged.map((i) => i['sku'])).toEqual(['IMP-0']);
  });

  it('stores nothing when any row is invalid, and says which row', async () => {
    const before = (await items.list(ctx)).length;
    const bad = rows(300, 1000);
    bad[250] = { ...bad[250]!, barcode: '4006381333932' } as never;
    const err = await items.bulkCreate(ctx, bad, { chunk: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ItemValidationError);
    expect((err as ItemValidationError).index).toBe(250);
    expect((await items.list(ctx)).length).toBe(before);
  });

  it('rejects duplicates inside the file and against stored items', async () => {
    const inside = [...rows(2, 2000), { name: 'Copy', sku: 'IMP-2000' }];
    await expect(items.bulkCreate(ctx, inside)).rejects.toMatchObject({
      index: 2,
      fields: { sku: 'duplicate_sku' },
    });
    await expect(
      items.bulkCreate(ctx, [{ name: 'Stored copy', sku: 'IMP-5' }]),
    ).rejects.toMatchObject({
      fields: { sku: 'duplicate_sku' },
    });
  });

  it('rolls everything back when cancelled part-way', async () => {
    const before = (await items.list(ctx)).length;
    let calls = 0;
    await expect(
      items.bulkCreate(ctx, rows(400, 3000), {
        chunk: 100,
        shouldCancel: () => ++calls > 2,
      }),
    ).rejects.toBeInstanceOf(ImportCancelled);
    expect((await items.list(ctx)).length).toBe(before);
    expect((await items.search(ctx, 'IMP-3000')).length).toBe(0);
  });

  it('posts opening stock for imported items', async () => {
    await items.bulkCreate(ctx, [
      {
        name: 'Imported stocked',
        sku: 'IMP-STOCK',
        track_stock: true,
        opening_stock_micros: 10_000_000,
        opening_stock_value_paise: 50_000,
      },
    ]);
    const stocked = (await items.search(ctx, 'IMP-STOCK'))[0]!;
    const m = (await new BaseRepo(d, 'stock_movements').list(ctx)).find(
      (x) => x['item_id'] === stocked['id'],
    );
    expect(m).toMatchObject({ qty_micros: 10_000_000, rate_paise: 5_000 });
  });
});

describe.each(DIALECTS)('units and import mappings (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('starts with the common units, each reporting its own UQC', async () => {
    const list = await new UnitRepo(d).list(ctx);
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(list.every((u) => u['uqc'] === u['code'] && !u['is_custom'])).toBe(true);
  });

  it('adds a standard unit once and a custom unit mapped to a UQC', async () => {
    const units = new UnitRepo(d);
    const a = await units.addStandard(ctx, 'BAG');
    const b = await units.addStandard(ctx, 'BAG');
    expect(b['id']).toBe(a['id']);
    const tray = await units.addCustom(ctx, { code: 'tray', name: 'Tray', uqc: 'NOS' });
    expect(tray).toMatchObject({ code: 'TRAY', is_custom: true, uqc: 'NOS' });
    await expect(
      units.addCustom(ctx, { code: 'TRAY', name: 'Again', uqc: 'NOS' }),
    ).rejects.toBeInstanceOf(RuleError);
    await expect(units.addCustom(ctx, { code: 'X', name: 'X', uqc: 'ZZZ' })).rejects.toBeInstanceOf(
      RuleError,
    );
    await expect(units.addStandard(ctx, 'NOPE')).rejects.toBeInstanceOf(RuleError);
  });

  it('will not remove a unit that an item uses', async () => {
    const units = new UnitRepo(d);
    const u = await units.addCustom(ctx, { code: 'CRATE', name: 'Crate', uqc: 'BOX' });
    await new ItemRepo(d).create(ctx, { name: 'Crated', unit_id: u['id'] });
    await expect(units.softDelete(ctx, u['id'], u['version'])).rejects.toBeInstanceOf(RuleError);
    const spare = await units.addCustom(ctx, { code: 'SPARE', name: 'Spare', uqc: 'BOX' });
    await expect(units.softDelete(ctx, spare['id'], spare['version'])).resolves.toBeTruthy();
  });

  it('saves a column mapping per header layout and finds it again in any column order', async () => {
    const maps = new ImportMappingRepo(d);
    const headers = ['Item Name', 'Rate', 'HSN'];
    expect(await maps.forHeaders(ctx, 'items', headers)).toBeNull();
    await maps.save(ctx, 'items', headers, { name: 'Item Name', sale_price: 'Rate' });
    await maps.save(ctx, 'items', headers, { name: 'Item Name', sale_price: 'Rate', hsn: 'HSN' });
    expect(await maps.forHeaders(ctx, 'items', ['HSN', 'Item Name', 'Rate'])).toEqual({
      name: 'Item Name',
      sale_price: 'Rate',
      hsn: 'HSN',
    });
    expect(await maps.forHeaders(ctx, 'parties', headers)).toBeNull();
    expect(await new BaseRepo(d, 'import_mappings').list(ctx)).toHaveLength(1);
  });
});

describe.each(DIALECTS)('scale (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await newTenant(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  const WORDS = [
    'cotton',
    'steel',
    'paper',
    'copper',
    'wood',
    'glass',
    'rubber',
    'wool',
    'silk',
    'brass',
    'tin',
    'zinc',
  ];
  const THINGS = [
    'shirts',
    'pipes',
    'sheets',
    'wire',
    'boards',
    'bottles',
    'tyres',
    'yarn',
    'cloth',
    'vessels',
    'foil',
    'plates',
  ];

  it('looks up a code description in under 50 ms among 10,000 codes', async () => {
    const master: HsnRow[] = Array.from({ length: 10_000 }, (_, i) => ({
      code: String(10_000_000 + i * 7).padStart(8, '0'),
      description: `${WORDS[i % 12]} ${THINGS[(i * 5) % 12]} grade ${i}`,
      rate_bp: [0, 500, 1200, 1800][i % 4]!,
      cess_bp: 0,
      effective_from: '2025-09-22',
    }));
    const imported = await importHsnVersion(
      d,
      { version: '2026.9.0', as_of: '2026-01-01' },
      master,
    );
    expect(imported.inserted).toBe(10_000);

    await searchHsn(d, 'warm up'); // first query pays for statement preparation
    // best of fifteen per query: a busy machine (parallel test runs, coverage) delays single runs
    const times: number[] = [];
    for (const q of [
      'cotton shirts',
      'steel pipes grade',
      'copper wire',
      'silk cloth 77',
      'glass bottles',
    ]) {
      let best = Infinity;
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        const hits = await searchHsn(d, q, { limit: 5, asOf: '2026-02-01' });
        best = Math.min(best, performance.now() - t0);
        expect(hits.length).toBeGreaterThan(0);
      }
      times.push(best);
    }
    const worst = Math.max(...times);
    // PGlite is Postgres compiled to WASM and runs a little slower than native SQLite.
    expect(worst).toBeLessThan(dialect === 'sqlite' ? 50 : 150);
  }, 120_000);

  it('imports 10,000 items in under 30 s with progress', async () => {
    const items = new ItemRepo(d);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      name: `${WORDS[i % 12]} ${THINGS[(i * 5) % 12]} ${i}`,
      sku: `BULK-${i}`,
      barcode: withCheckDigit(`890${String(100_000_000 + i * 13).padStart(9, '0')}`),
      hsn: '10000000',
      gst_rate_bp: 1800,
      sale_rate_paise: 10_000 + i,
      purchase_rate_paise: 8_000 + i,
      tags_json: ['bulk'],
    }));
    let last = 0;
    const t0 = performance.now();
    const r = await items.bulkCreate(ctx, rows, { onProgress: (done) => void (last = done) });
    const seconds = (performance.now() - t0) / 1000;
    expect(r.created).toBe(10_000);
    expect(last).toBe(10_000);
    expect(seconds).toBeLessThan(30);
    const s0 = performance.now();
    expect((await items.search(ctx, 'BULK-9999')).length).toBe(1);
    expect(performance.now() - s0).toBeLessThan(100);
  }, 180_000);
});
