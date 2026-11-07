/**
 * Item rules shared by the form, the CSV import and the repository, so one definition decides
 * what a valid item is. Money is integer paise, rates are basis points, quantities micro-units.
 */
import { validateBarcode } from './barcode';

export type ItemKind = 'goods' | 'service';

export interface ItemFields {
  kind: ItemKind;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  hsn?: string | null;
  gst_rate_bp?: number | null;
  cess_bp?: number | null;
  sale_rate_paise?: number | null;
  purchase_rate_paise?: number | null;
  mrp_paise?: number | null;
  tax_inclusive?: boolean | null;
  unit_id?: string | null;
  secondary_unit_id?: string | null;
  /** Primary units in one secondary unit, in micro-units. */
  secondary_factor_micros?: number | null;
  track_stock?: boolean | null;
  /** none, batch or serial (prompt 51). */
  tracking_mode?: string | null;
  expiry_required?: boolean | null;
  default_godown_id?: string | null;
  opening_stock_micros?: number | null;
  opening_stock_value_paise?: number | null;
  min_stock_micros?: number | null;
}

/** GST slabs in basis points: 0, 0.1, 0.25, 1, 1.5, 3, 5, 7.5, 12, 18, 28, 40 percent. */
export const GST_RATES_BP: readonly number[] = [
  0, 10, 25, 100, 150, 300, 500, 750, 1200, 1800, 2800, 4000,
];

export const MAX_CESS_BP = 100_000;

export type ItemErrorCode =
  | 'name'
  | 'sku'
  | 'barcode_checksum'
  | 'barcode_chars'
  | 'hsn'
  | 'hsn_kind'
  | 'gst_rate'
  | 'cess'
  | 'amount'
  | 'secondary_same'
  | 'secondary_factor'
  | 'service_stock'
  | 'opening_qty'
  | 'opening_value'
  | 'tracking_mode'
  | 'tracking_change'
  | 'godown';

export type ItemWarningCode =
  'gst_overridden' | 'sale_above_mrp' | 'sale_below_purchase' | 'no_hsn';

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const present = (n: number | null | undefined): n is number => n !== null && n !== undefined;

/** 4, 6 or 8 digits. A chapter alone (2 digits) is not specific enough to invoice with. */
export const isItemHsn = (code: string) => /^(?:\d{4}|\d{6}|\d{8})$/.test(code);

/** SAC codes (services) start with 99. */
export const isSac = (code: string) => code.startsWith('99');

/** Field-level problems. Empty object means valid. */
export function validateItemInput(i: ItemFields): Partial<Record<keyof ItemFields, ItemErrorCode>> {
  const e: Partial<Record<keyof ItemFields, ItemErrorCode>> = {};
  if (i.name.trim().length < 2) e.name = 'name';
  if (i.sku && i.sku.trim().length > 40) e.sku = 'sku';

  if (i.barcode && i.barcode.trim() !== '') {
    const b = validateBarcode(i.barcode);
    if (!b.ok) e.barcode = b.reason === 'checksum' ? 'barcode_checksum' : 'barcode_chars';
  }

  if (i.hsn && i.hsn.trim() !== '') {
    const code = i.hsn.trim();
    if (!isItemHsn(code)) e.hsn = 'hsn';
    else if ((i.kind === 'service') !== isSac(code)) e.hsn = 'hsn_kind';
  }

  if (present(i.gst_rate_bp) && !GST_RATES_BP.includes(i.gst_rate_bp)) e.gst_rate_bp = 'gst_rate';
  if (present(i.cess_bp) && !(isCount(i.cess_bp) && i.cess_bp <= MAX_CESS_BP)) e.cess_bp = 'cess';

  for (const k of ['sale_rate_paise', 'purchase_rate_paise', 'mrp_paise'] as const) {
    if (present(i[k]) && !isCount(i[k])) e[k] = 'amount';
  }

  if (i.secondary_unit_id) {
    if (i.secondary_unit_id === i.unit_id) e.secondary_unit_id = 'secondary_same';
    if (!isCount(i.secondary_factor_micros) || i.secondary_factor_micros === 0)
      e.secondary_factor_micros = 'secondary_factor';
  }

  if (i.kind === 'service' && i.track_stock) e.track_stock = 'service_stock';
  const mode = i.tracking_mode ?? 'none';
  if (!['none', 'batch', 'serial'].includes(mode)) e.tracking_mode = 'tracking_mode';
  else if (mode !== 'none' && !i.track_stock) e.tracking_mode = 'tracking_mode';
  if (i.expiry_required && mode !== 'batch') e.expiry_required = 'tracking_mode';
  if (present(i.min_stock_micros) && !isCount(i.min_stock_micros))
    e.min_stock_micros = 'opening_qty';
  if (present(i.opening_stock_micros) && !isCount(i.opening_stock_micros))
    e.opening_stock_micros = 'opening_qty';
  if (present(i.opening_stock_value_paise) && !isCount(i.opening_stock_value_paise))
    e.opening_stock_value_paise = 'opening_value';
  if (
    !e.opening_stock_value_paise &&
    (i.opening_stock_value_paise ?? 0) > 0 &&
    (i.opening_stock_micros ?? 0) === 0
  )
    e.opening_stock_value_paise = 'opening_value';
  if ((i.opening_stock_micros ?? 0) > 0 && !i.track_stock) e.opening_stock_micros = 'opening_qty';
  return e;
}

/**
 * Things worth a second look that do not block saving. `masterRateBp` is the rate the HSN master
 * gives for the item's code today, when known.
 */
export function itemWarnings(i: ItemFields, masterRateBp?: number | null): ItemWarningCode[] {
  const out: ItemWarningCode[] = [];
  if (present(masterRateBp) && present(i.gst_rate_bp) && masterRateBp !== i.gst_rate_bp)
    out.push('gst_overridden');
  if (
    present(i.sale_rate_paise) &&
    present(i.mrp_paise) &&
    i.mrp_paise > 0 &&
    i.sale_rate_paise > i.mrp_paise
  )
    out.push('sale_above_mrp');
  if (
    present(i.sale_rate_paise) &&
    present(i.purchase_rate_paise) &&
    i.purchase_rate_paise > 0 &&
    i.sale_rate_paise < i.purchase_rate_paise
  )
    out.push('sale_below_purchase');
  if (!i.hsn || i.hsn.trim() === '') out.push('no_hsn');
  return out;
}
