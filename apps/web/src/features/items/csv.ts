import type { Row } from '@gst/db';
import { toCsv, toDecimalString, type CsvValue } from '@gst/domain';

import { trimZeros } from './form';

/** Column headers of the item export, which are also the headers the import recognises on sight. */
export const ITEM_CSV_HEADERS = [
  'Name',
  'Type',
  'SKU',
  'Barcode',
  'HSN/SAC',
  'Unit',
  'Sale Price',
  'Purchase Price',
  'MRP',
  'GST Rate %',
  'Cess %',
  'Tax Inclusive',
  'Opening Stock',
  'Opening Value',
  'Reorder Level',
  'Tags',
  'Active',
] as const;

const amount = (n: unknown): CsvValue =>
  n === null || n === undefined ? '' : { numeric: toDecimalString(BigInt(n as number)) };
const rate = (n: unknown): CsvValue =>
  n === null || n === undefined ? '' : { numeric: trimZeros(toDecimalString(BigInt(n as number))) };
const qty = (n: unknown): CsvValue =>
  !n ? '' : { numeric: trimZeros(toDecimalString(BigInt(n as number), 6)) };

/** Items as CSV in the shape the import reads back (same headers, plain numbers, `Yes`/`No`). */
export function itemsCsv(items: readonly Row[], unitCodes: ReadonlyMap<string, string>): string {
  return toCsv([
    [...ITEM_CSV_HEADERS],
    ...items.map((r): CsvValue[] => [
      r['name'],
      r['kind'],
      r['sku'] ?? '',
      r['barcode'] ?? '',
      r['hsn'] ?? '',
      unitCodes.get(r['unit_id']) ?? '',
      amount(r['sale_rate_paise']),
      amount(r['purchase_rate_paise']),
      amount(r['mrp_paise']),
      rate(r['gst_rate_bp']),
      rate(r['cess_bp']),
      r['tax_inclusive'] ? 'Yes' : 'No',
      qty(r['opening_stock_micros']),
      amount(r['opening_stock_value_paise']),
      qty(r['min_stock_micros']),
      ((r['tags_json'] ?? []) as string[]).join(', '),
      r['is_active'] === false ? 'No' : 'Yes',
    ]),
  ]);
}

/** A small example file people can fill in. */
export const ITEM_TEMPLATE = toCsv([
  [...ITEM_CSV_HEADERS],
  [
    'Tea 250g',
    'goods',
    'TEA-250',
    '',
    '0902',
    'NOS',
    '120.00',
    '90.00',
    '130.00',
    '5',
    '',
    'No',
    '',
    '',
    '',
    'grocery',
    'Yes',
  ],
]);
