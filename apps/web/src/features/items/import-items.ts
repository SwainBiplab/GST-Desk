import { ItemRepo, UnitRepo, type Row } from '@gst/db';
import { ITEM_FIELDS, parseBool, readRow } from '@gst/domain';

import type { ImportInput, ImportProblem, ImportReview, ImportSpec } from '../import/types';

import { ITEM_TEMPLATE } from './csv';
import { draftToValues, emptyItemDraft, validateItem, type ItemDraft } from './form';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Unit lookup by code or name, ignoring case and punctuation. */
export function unitIndex(units: readonly Row[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const u of units) {
    m.set(norm(u['code']), u['id']);
    m.set(norm(u['name']), u['id']);
  }
  return m;
}

const GOODS = new Set(['goods', 'good', 'g', 'product', 'products']);
const SERVICE = new Set(['service', 'services', 's']);

/** Turn one mapped file row into an item draft, reporting what could not be understood. */
export function itemDraftFromRow(
  r: Record<string, string>,
  units: ReadonlyMap<string, string>,
): { draft: ItemDraft; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const bad = (field: string, code: string) => problems.push({ field, code });

  const hsn = r['hsn']!.replace(/[\s.]/g, '');
  const kindText = norm(r['kind']!);
  let kind: ItemDraft['kind'] = hsn.startsWith('99') ? 'service' : 'goods';
  if (kindText !== '') {
    if (SERVICE.has(kindText)) kind = 'service';
    else if (GOODS.has(kindText)) kind = 'goods';
    else bad('kind', 'kind');
  }

  let unitId = '';
  if (r['unit']) {
    unitId = units.get(norm(r['unit'])) ?? '';
    if (!unitId) bad('unit', 'unit_unknown');
  }

  const inclusive = parseBool(r['tax_inclusive']!);
  if (inclusive === null) bad('tax_inclusive', 'bool');
  const active = parseBool(r['active']!);
  if (active === null) bad('active', 'bool');

  const openingQty = r['opening_qty']!;
  const draft = emptyItemDraft({
    kind,
    name: r['name']!,
    sku: r['sku']!,
    barcode: r['barcode']!,
    hsn,
    gstRate: r['gst_rate']!,
    cess: r['cess']!,
    taxInclusive: inclusive === true,
    salePrice: r['sale_price']!,
    purchasePrice: r['purchase_price']!,
    mrp: r['mrp']!,
    unitId,
    trackStock: kind === 'goods' && openingQty !== '',
    openingQty,
    openingValue: r['opening_value']!,
    reorder: r['reorder']!,
    tags: r['tags']!,
    isActive: active !== false,
  });
  return { draft, problems };
}

/** Check every row of an item file, including SKU and barcode clashes inside the file and with stored items. */
export async function reviewItemRows(input: ImportInput): Promise<ImportReview> {
  const { database, ctx } = input;
  // one after the other: a database connection runs one transaction at a time
  const unitRows = await new UnitRepo(database).list(ctx);
  const existing = await new ItemRepo(database).existingKeys(ctx);
  const units = unitIndex(unitRows);
  const skus = new Set(existing.skus);
  const barcodes = new Set(existing.barcodes);
  const review: ImportReview = { total: input.rows.length, valid: [], invalid: [] };

  input.rows.forEach((raw, i) => {
    const line = input.lines[i]!;
    const { draft, problems } = itemDraftFromRow(readRow(raw, input.mapping), units);
    const errors = validateItem(draft);
    for (const [field, code] of Object.entries(errors)) problems.push({ field, code });
    const sku = draft.sku.trim();
    const barcode = draft.barcode.trim();
    if (sku && skus.has(sku) && !errors['sku'])
      problems.push({ field: 'sku', code: 'duplicate_sku' });
    if (barcode && barcodes.has(barcode) && !errors['barcode'])
      problems.push({ field: 'barcode', code: 'duplicate_barcode' });
    if (problems.length > 0) {
      review.invalid.push({ line, problems, raw });
      return;
    }
    if (sku) skus.add(sku);
    if (barcode) barcodes.add(barcode);
    review.valid.push({ line, values: draftToValues(draft), raw });
  });
  return review;
}

export const itemImport: ImportSpec = {
  entity: 'items',
  fields: ITEM_FIELDS,
  review: reviewItemRows,
  async commit({ values, database, ctx, onProgress, shouldCancel }) {
    const r = await new ItemRepo(database).bulkCreate(ctx, values, { onProgress, shouldCancel });
    return r.created;
  },
  template: ITEM_TEMPLATE,
  templateName: 'items-template.csv',
};
