/**
 * Which documents count toward turnover and which GSTR-1 table they land in.
 * Only issued documents count; drafts and cancelled documents never do.
 */
import type { SupplyType } from './tax/supply';

export type DocumentType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'proforma'
  | 'quotation'
  | 'credit_note'
  | 'debit_note'
  | 'delivery_challan'
  | 'receipt_voucher'
  | 'purchase_bill'
  | 'purchase_return'
  | 'expense'
  /** The recipient's own invoice for tax it pays under reverse charge (linked to the supplier's bill). */
  | 'rcm_self_invoice';

export type DocumentStatus = 'draft' | 'issued' | 'cancelled';

/** +1 adds to outward turnover, -1 reduces it, 0 is ignored. */
export function turnoverSign(type: DocumentType, status: DocumentStatus): 1 | -1 | 0 {
  if (status !== 'issued') return 0;
  switch (type) {
    case 'tax_invoice':
    case 'bill_of_supply':
    case 'debit_note':
      return 1;
    case 'credit_note':
      return -1;
    default:
      return 0;
  }
}

/** Documents that report inward supplies (GSTR-2B reconciliation, ITC). */
export function isInward(type: DocumentType, status: DocumentStatus): boolean {
  return (
    status === 'issued' &&
    (type === 'purchase_bill' || type === 'purchase_return' || type === 'expense')
  );
}

export type Gstr1Table = 'B2B' | 'B2CL' | 'B2CS' | 'EXP' | 'CDNR' | 'CDNUR' | 'NIL' | 'NONE';

/** Inter-state unregistered invoices above this value go to B2CL (paise). Lowered on 1 Aug 2024. */
export function b2clThreshold(date: string): bigint {
  return date >= '2024-08-01' ? 10_000_000n : 25_000_000n;
}

export interface Gstr1Input {
  type: DocumentType;
  status: DocumentStatus;
  supply: SupplyType;
  /** Recipient has a GSTIN. */
  registered: boolean;
  /** Invoice value (total paise). */
  totalPaise: bigint;
  date: string;
  /** Every line is exempt, nil-rated or non-GST. */
  allNil?: boolean;
}

/** Map an outward document to its GSTR-1 table. */
export function gstr1Table(i: Gstr1Input): Gstr1Table {
  if (turnoverSign(i.type, i.status) === 0) return 'NONE';
  if (i.type === 'credit_note' || i.type === 'debit_note') return i.registered ? 'CDNR' : 'CDNUR';
  if (i.allNil) return 'NIL';
  if (i.supply === 'export') return 'EXP';
  if (
    i.registered ||
    i.supply === 'sez_with_tax' ||
    i.supply === 'sez_without_tax' ||
    i.supply === 'deemed_export'
  ) {
    return 'B2B';
  }
  if (i.supply === 'inter' && i.totalPaise > b2clThreshold(i.date)) return 'B2CL';
  return 'B2CS';
}
