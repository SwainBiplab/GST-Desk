/**
 * Column mapping for CSV import: guess which file column feeds which field, reuse a mapping the
 * user saved for the same header layout, and read rows through a mapping. Pure TypeScript.
 */

export interface FieldDef {
  key: string;
  required?: boolean;
  /** Extra header spellings, compared after `normHeader`. The key itself always matches. */
  aliases: string[];
}

/** Field key to file column index, or null when the field is not mapped. */
export type Mapping = Record<string, number | null>;

/** Field key to header text. Saved mappings use header text so they survive a column reorder. */
export type SavedMapping = Record<string, string | null>;

export const normHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The same for any file that has the same set of columns, in any order. */
export const headerSignature = (headers: readonly string[]): string =>
  headers.map(normHeader).filter(Boolean).sort().join('|').slice(0, 400);

export function detectMapping(
  headers: readonly string[],
  fields: readonly FieldDef[],
  saved?: SavedMapping | null,
): Mapping {
  const norm = headers.map(normHeader);
  const used = new Set<number>();
  const mapping: Mapping = Object.fromEntries(fields.map((f) => [f.key, null]));

  const claim = (key: string, index: number) => {
    mapping[key] = index;
    used.add(index);
  };

  if (saved) {
    for (const f of fields) {
      const header = saved[f.key];
      if (!header) continue;
      const i = norm.findIndex((h, idx) => h === normHeader(header) && !used.has(idx));
      if (i >= 0) claim(f.key, i);
    }
  }
  for (const f of fields) {
    if (mapping[f.key] !== null) continue;
    const names = new Set([normHeader(f.key), ...f.aliases.map(normHeader)]);
    const i = norm.findIndex((h, idx) => names.has(h) && !used.has(idx));
    if (i >= 0) claim(f.key, i);
  }
  return mapping;
}

export function toSavedMapping(headers: readonly string[], mapping: Mapping): SavedMapping {
  return Object.fromEntries(
    Object.entries(mapping).map(([k, i]) => [k, i === null ? null : (headers[i] ?? null)]),
  );
}

/** Required fields that have no column. */
export const missingRequired = (mapping: Mapping, fields: readonly FieldDef[]): string[] =>
  fields.filter((f) => f.required && mapping[f.key] === null).map((f) => f.key);

/** One row read through a mapping: trimmed text per field key (empty string when unmapped). */
export function readRow(cells: readonly string[], mapping: Mapping): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, i] of Object.entries(mapping))
    out[key] = i === null ? '' : (cells[i] ?? '').trim();
  return out;
}

/* ------------------------------------------------------------------ field definitions */

export const ITEM_FIELDS: readonly FieldDef[] = [
  {
    key: 'name',
    required: true,
    aliases: ['item name', 'product name', 'item', 'product', 'particulars', 'description'],
  },
  { key: 'kind', aliases: ['type', 'item type', 'goods or service', 'goods/service'] },
  { key: 'sku', aliases: ['item code', 'product code', 'code', 'sku code'] },
  { key: 'barcode', aliases: ['ean', 'upc', 'gtin', 'bar code'] },
  { key: 'hsn', aliases: ['hsn code', 'hsn/sac', 'sac', 'hsn sac', 'hsn/sac code'] },
  { key: 'unit', aliases: ['uom', 'uqc', 'unit of measure', 'units'] },
  {
    key: 'sale_price',
    aliases: ['selling price', 'sales price', 'price', 'sale rate', 'rate', 'sp'],
  },
  { key: 'purchase_price', aliases: ['cost price', 'buying price', 'purchase rate', 'cost', 'cp'] },
  { key: 'mrp', aliases: ['maximum retail price', 'm.r.p'] },
  { key: 'gst_rate', aliases: ['gst', 'gst %', 'gst percent', 'tax rate', 'tax %', 'igst', 'tax'] },
  { key: 'cess', aliases: ['cess rate', 'cess %'] },
  {
    key: 'tax_inclusive',
    aliases: ['inclusive of tax', 'price includes tax', 'tax included', 'inclusive'],
  },
  {
    key: 'opening_qty',
    aliases: ['opening stock', 'opening quantity', 'stock', 'quantity', 'qty', 'opening qty'],
  },
  { key: 'opening_value', aliases: ['opening stock value', 'stock value', 'opening amount'] },
  { key: 'reorder', aliases: ['reorder level', 'min stock', 'minimum stock', 'reorder qty'] },
  { key: 'tags', aliases: ['tag', 'category', 'group', 'labels'] },
  { key: 'active', aliases: ['is active', 'status', 'enabled'] },
];

export const PARTY_FIELDS: readonly FieldDef[] = [
  {
    key: 'name',
    required: true,
    aliases: [
      'party name',
      'customer name',
      'supplier name',
      'vendor name',
      'customer',
      'party',
      'company name',
      'legal name',
      'ledger name',
    ],
  },
  { key: 'trade_name', aliases: ['display name', 'alias', 'business name'] },
  { key: 'type', aliases: ['party type', 'customer or supplier', 'category'] },
  { key: 'gstin', aliases: ['gst no', 'gst number', 'gstin/uin', 'gst'] },
  {
    key: 'phone',
    aliases: ['mobile', 'phone no', 'mobile no', 'contact', 'contact no', 'telephone'],
  },
  { key: 'email', aliases: ['email id', 'e-mail', 'mail'] },
  { key: 'address', aliases: ['address line 1', 'billing address', 'street'] },
  { key: 'city', aliases: ['town', 'district'] },
  { key: 'state', aliases: ['state name', 'state code', 'place of supply'] },
  { key: 'pincode', aliases: ['pin', 'pin code', 'zip', 'postal code'] },
  { key: 'credit_days', aliases: ['credit period', 'payment terms', 'credit'] },
  { key: 'opening_balance', aliases: ['balance', 'outstanding', 'opening bal', 'opening amount'] },
  { key: 'tags', aliases: ['tag', 'group', 'labels'] },
];
