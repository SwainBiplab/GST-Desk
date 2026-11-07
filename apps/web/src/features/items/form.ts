/**
 * The item form as plain data: strings as typed, parsed and validated through the shared domain
 * rules (`validateItemInput`), then turned into what `ItemRepo` stores. The CSV import builds the
 * same drafts, so a row and a form are checked by the same code.
 */
import type { Row } from '@gst/db';
import {
  parseAmountPaise,
  parseQtyMicros,
  parseRateBp,
  toDecimalString,
  validateItemInput,
  type ItemFields,
} from '@gst/domain';

/** Where an item picture's bytes are held (the blob store keeps them by hash). */
export interface ImageRef {
  sha256: string;
  mime: string;
  storagePath: string;
  name: string;
}

export const MAX_IMAGES = 5;

export interface ItemDraft {
  kind: 'goods' | 'service';
  name: string;
  /** The Roman-letter form of the name, kept when it is typed in a native script, for search. */
  nameLatin: string;
  description: string;
  sku: string;
  barcode: string;
  hsn: string;
  /** Percent as typed: "18", "1.5". Blank means not set. */
  gstRate: string;
  cess: string;
  taxInclusive: boolean;
  salePrice: string;
  purchasePrice: string;
  mrp: string;
  unitId: string;
  secondaryUnitId: string;
  /** Primary units in one secondary unit, as typed: "12". */
  secondaryFactor: string;
  trackStock: boolean;
  /** none, batch or serial (prompt 51). */
  trackingMode: 'none' | 'batch' | 'serial';
  expiryRequired: boolean;
  defaultGodownId: string;
  openingQty: string;
  openingValue: string;
  reorder: string;
  tags: string;
  images: ImageRef[];
  isActive: boolean;
}

export type Errors = Record<string, string>;

export const emptyItemDraft = (over: Partial<ItemDraft> = {}): ItemDraft => ({
  kind: 'goods',
  name: '',
  nameLatin: '',
  description: '',
  sku: '',
  barcode: '',
  hsn: '',
  gstRate: '',
  cess: '',
  taxInclusive: false,
  salePrice: '',
  purchasePrice: '',
  mrp: '',
  unitId: '',
  secondaryUnitId: '',
  secondaryFactor: '',
  trackStock: false,
  trackingMode: 'none',
  expiryRequired: false,
  defaultGodownId: '',
  openingQty: '',
  openingValue: '',
  reorder: '',
  tags: '',
  images: [],
  isActive: true,
  ...over,
});

/** Domain field name to the form field it belongs to. */
const FORM_FIELD: Record<string, keyof ItemDraft> = {
  name: 'name',
  sku: 'sku',
  barcode: 'barcode',
  hsn: 'hsn',
  gst_rate_bp: 'gstRate',
  cess_bp: 'cess',
  sale_rate_paise: 'salePrice',
  purchase_rate_paise: 'purchasePrice',
  mrp_paise: 'mrp',
  unit_id: 'unitId',
  secondary_unit_id: 'secondaryUnitId',
  secondary_factor_micros: 'secondaryFactor',
  track_stock: 'trackStock',
  tracking_mode: 'trackingMode',
  expiry_required: 'expiryRequired',
  default_godown_id: 'defaultGodownId',
  opening_stock_micros: 'openingQty',
  opening_stock_value_paise: 'openingValue',
  opening_stock_value: 'openingValue',
  min_stock_micros: 'reorder',
};

/** Problems the repository reports (by database field) as form errors. */
export function serverErrorsToForm(fields: Record<string, string>): Errors {
  const out: Errors = {};
  for (const [key, code] of Object.entries(fields)) out[FORM_FIELD[key] ?? key] = code;
  return out;
}

export const parseTagList = (text: string): string[] => {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((t) => t.trim().replace(/\s+/g, ' '))
    .filter((t) => t !== '' && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
};

interface Parsed {
  fields: ItemFields;
  errors: Errors;
}

const num = (
  errors: Errors,
  field: keyof ItemDraft,
  value: number | null | undefined,
  code: string,
): number | null => {
  if (value === null) {
    errors[field] = code;
    return null;
  }
  return value ?? null;
};

/** Parse the typed values. Anything unreadable is reported under its form field. */
export function parseDraft(d: ItemDraft): Parsed {
  const errors: Errors = {};
  const sale = num(errors, 'salePrice', parseAmountPaise(d.salePrice), 'amount');
  const buy = num(errors, 'purchasePrice', parseAmountPaise(d.purchasePrice), 'amount');
  const mrp = num(errors, 'mrp', parseAmountPaise(d.mrp), 'amount');
  const rate = num(errors, 'gstRate', parseRateBp(d.gstRate), 'gst_rate');
  const cess = num(errors, 'cess', parseRateBp(d.cess), 'cess');
  const factor = num(
    errors,
    'secondaryFactor',
    parseQtyMicros(d.secondaryFactor),
    'secondary_factor',
  );
  const openQty = num(errors, 'openingQty', parseQtyMicros(d.openingQty), 'opening_qty');
  const openValue = num(errors, 'openingValue', parseAmountPaise(d.openingValue), 'opening_value');
  const reorder = num(errors, 'reorder', parseQtyMicros(d.reorder), 'opening_qty');
  const fields: ItemFields = {
    kind: d.kind,
    name: d.name,
    sku: d.sku.trim() || null,
    barcode: d.barcode.trim() || null,
    hsn: d.hsn.replace(/\s+/g, '') || null,
    gst_rate_bp: rate,
    cess_bp: cess,
    sale_rate_paise: sale,
    purchase_rate_paise: buy,
    mrp_paise: mrp,
    tax_inclusive: d.taxInclusive,
    unit_id: d.unitId || null,
    secondary_unit_id: d.secondaryUnitId || null,
    secondary_factor_micros: d.secondaryUnitId ? factor : null,
    track_stock: d.trackStock,
    tracking_mode: d.trackStock ? d.trackingMode : 'none',
    expiry_required: d.trackStock && d.trackingMode === 'batch' ? d.expiryRequired : false,
    default_godown_id: d.defaultGodownId || null,
    opening_stock_micros: openQty,
    opening_stock_value_paise: openValue,
    min_stock_micros: reorder,
  };
  return { fields, errors };
}

/** Everything wrong with a draft: unreadable numbers first, then the domain rules. */
export function validateItem(d: ItemDraft): Errors {
  const { fields, errors } = parseDraft(d);
  const ruled = validateItemInput(fields);
  for (const [key, code] of Object.entries(ruled)) {
    const field = FORM_FIELD[key] ?? (key as keyof ItemDraft);
    if (!errors[field]) errors[field] = code;
  }
  return errors;
}

/** Values for `ItemRepo.create` / `update`. Call after `validateItem` returned no errors. */
export function draftToValues(d: ItemDraft): Record<string, unknown> {
  const { fields } = parseParsedOrThrow(d);
  return {
    kind: d.kind,
    name: d.name.trim(),
    name_latin: d.nameLatin.trim() || null,
    description: d.description.trim() || null,
    sku: fields.sku ?? null,
    barcode: fields.barcode ?? null,
    hsn: fields.hsn ?? null,
    unit_id: fields.unit_id ?? null,
    secondary_unit_id: fields.secondary_unit_id ?? null,
    secondary_factor_micros: fields.secondary_factor_micros ?? null,
    sale_rate_paise: fields.sale_rate_paise ?? 0,
    purchase_rate_paise: fields.purchase_rate_paise ?? 0,
    mrp_paise: fields.mrp_paise ?? null,
    tax_inclusive: d.taxInclusive,
    gst_rate_bp: fields.gst_rate_bp ?? 0,
    cess_bp: fields.cess_bp ?? 0,
    track_stock: d.kind === 'service' ? false : d.trackStock,
    tracking_mode: fields.tracking_mode ?? 'none',
    expiry_required: fields.expiry_required ?? false,
    default_godown_id: fields.default_godown_id ?? null,
    min_stock_micros: fields.min_stock_micros ?? 0,
    opening_stock_micros: fields.opening_stock_micros ?? 0,
    opening_stock_value_paise: fields.opening_stock_value_paise ?? 0,
    tags_json: parseTagList(d.tags),
    images_json: d.images,
    is_active: d.isActive,
  };
}

function parseParsedOrThrow(d: ItemDraft): Parsed {
  const p = parseDraft(d);
  if (Object.keys(p.errors).length > 0) throw new RangeError('draft has unreadable values');
  return p;
}

const text = (n: unknown, scale = 2): string =>
  n === null || n === undefined || Number(n) === 0
    ? ''
    : toDecimalString(BigInt(n as number), scale);

/** Fill the form from a stored row. Zero prices show blank, as they would for a new item. */
export function rowToDraft(r: Row): ItemDraft {
  const rate = r['gst_rate_bp'] as number | null;
  return emptyItemDraft({
    kind: r['kind'],
    name: r['name'] ?? '',
    nameLatin: r['name_latin'] ?? '',
    description: r['description'] ?? '',
    sku: r['sku'] ?? '',
    barcode: r['barcode'] ?? '',
    hsn: r['hsn'] ?? '',
    gstRate: rate === null || rate === undefined ? '' : trimZeros(toDecimalString(BigInt(rate))),
    cess: text(r['cess_bp']) ? trimZeros(text(r['cess_bp'])) : '',
    taxInclusive: !!r['tax_inclusive'],
    salePrice: text(r['sale_rate_paise']),
    purchasePrice: text(r['purchase_rate_paise']),
    mrp: text(r['mrp_paise']),
    unitId: r['unit_id'] ?? '',
    secondaryUnitId: r['secondary_unit_id'] ?? '',
    secondaryFactor: r['secondary_factor_micros']
      ? trimZeros(text(r['secondary_factor_micros'], 6))
      : '',
    trackStock: !!r['track_stock'],
    trackingMode: (['batch', 'serial'].includes(String(r['tracking_mode']))
      ? r['tracking_mode']
      : 'none') as ItemDraft['trackingMode'],
    expiryRequired: !!r['expiry_required'],
    defaultGodownId: r['default_godown_id'] ?? '',
    openingQty: r['opening_stock_micros'] ? trimZeros(text(r['opening_stock_micros'], 6)) : '',
    openingValue: text(r['opening_stock_value_paise']),
    reorder: r['min_stock_micros'] ? trimZeros(text(r['min_stock_micros'], 6)) : '',
    tags: ((r['tags_json'] ?? []) as string[]).join(', '),
    images: ((r['images_json'] ?? []) as ImageRef[]).slice(0, MAX_IMAGES),
    isActive: r['is_active'] !== false,
  });
}

/** "18.00" becomes "18", "1.50" becomes "1.5". */
export const trimZeros = (s: string): string =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

/** A word and its simple singular forms, so "pipe" finds "pipes" and "box" finds "boxes". */
const forms = (w: string): string[] => [
  w,
  w.replace(/s$/, ''),
  w.replace(/es$/, ''),
  w.replace(/ies$/, 'y'),
];

/** Words of `query` that appear in `description`: the reason a suggestion was offered. */
export function matchedWords(query: string, description: string): string[] {
  const have = new Set((description.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(forms));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (forms(q).some((f) => have.has(f)) && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}
