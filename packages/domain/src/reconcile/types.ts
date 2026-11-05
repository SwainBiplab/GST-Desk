/** GSTR-2B reconciliation: inputs, results and options. Money is integer paise. */

export type Entry2BType = 'invoice' | 'credit_note' | 'debit_note';

/** One supplier document as the portal lists it in GSTR-2B. */
export interface Entry2B {
  id: string;
  supplierGstin: string;
  supplierName: string;
  docType: Entry2BType;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Whether the portal says the credit is available: Y, N, or empty when it does not say. */
  itcAvailable: 'Y' | 'N' | '';
  /** The portal's reason when the credit is not available. */
  reason: string;
  /** The month the supplier reported it in (MMYYYY), when given. */
  supplierPeriod: string;
  /** The 2B period it was imported for (MMYYYY). */
  period: string;
}

/** A purchase bill or return from the books. */
export interface BookBill {
  id: string;
  supplierGstin: string;
  number: string;
  date: string;
  type: 'purchase_bill' | 'purchase_return';
  /** The person ticked that the credit may be claimed. Absent means yes; no means none is claimed. */
  itcEligible?: boolean;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export type MatchClass =
  | 'matched'
  | 'matched_with_differences'
  | 'in_2b_not_in_books'
  | 'in_books_not_in_2b'
  | 'duplicate_in_books';

export type Diff = 'number' | 'date' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess';

export interface Match {
  cls: MatchClass;
  entryId: string | null;
  billId: string | null;
  diffs: Diff[];
  /** Matched by the looser rules (the numbers were not the same after normalising, or the date was far). */
  fuzzy: boolean;
  /** The 2B figure less the books figure, per field, in paise (positive: the portal shows more). */
  delta: { taxable: number; igst: number; cgst: number; sgst: number; cess: number };
  /** For a duplicate: the bill it repeats. */
  duplicateOf: string | null;
}

export interface ReconOptions {
  /** A bill and a 2B line with the same number may differ by this many days and still be an exact match. */
  exactDateDays: number;
  /** The widest date gap a fuzzy match accepts. */
  fuzzyDateDays: number;
  /** Amounts differ by no more than the larger of this many paise and `amountToleranceBp` of the amount. */
  amountTolerancePaise: number;
  /** Basis points of the amount (100 = 1%). */
  amountToleranceBp: number;
}

export const DEFAULT_RECON_OPTIONS: ReconOptions = {
  exactDateDays: 3,
  fuzzyDateDays: 45,
  amountTolerancePaise: 100,
  // a percentage forgives real differences on large bills (0.5% of INR 10 lakh is INR 5,000): none by default
  amountToleranceBp: 0,
};

export interface ParsedReturn2B {
  /** MMYYYY of the 2B. */
  period: string;
  gstin: string;
  /** The layout version the parser recognised. */
  version: string;
  entries: Omit<Entry2B, 'id' | 'period'>[];
  /** What the parser could not read (the rest is still imported). */
  problems: string[];
  /**
   * Reverse-charge lines left out on purpose: their credit is claimed from the business's own
   * reverse-charge bills (table 4A(3)), not from 2B.
   */
  reverseChargeLeftOut?: number;
}
