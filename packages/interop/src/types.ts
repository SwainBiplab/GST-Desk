/** The neutral shapes every source (Tally, Vyapar, a spreadsheet) is turned into before anything is stored. */
import type { DocumentType } from '@gst/domain';

export type ImportSource = 'tally' | 'vyapar' | 'excel';

export interface ImportParty {
  name: string;
  type: 'customer' | 'supplier' | 'both';
  gstin: string;
  pan: string;
  /** Two-digit state code, or empty when it could not be worked out. */
  stateCode: string;
  phone: string;
  email: string;
  addressLine: string;
  city: string;
  pincode: string;
  /** Positive: they owe us. Negative: we owe them. Zero when none was given. */
  openingBalancePaise: bigint;
  country: string;
}

export interface ImportItem {
  name: string;
  sku: string;
  hsn: string;
  /** The unit as the file spells it, for example `Nos` or `KGS`. */
  unit: string;
  /** Total GST rate in basis points, or null when the file does not say. */
  gstRateBp: number | null;
  sellPaise: bigint;
  buyPaise: bigint;
  kind: 'goods' | 'service';
}

export interface ImportLine {
  description: string;
  /** The stock item or catalogue item it came from, when the file names one. */
  itemName: string | null;
  hsn: string;
  qtyMicros: bigint;
  unit: string;
  ratePaise: bigint;
  /** Discount on the line, in paise, off the quantity times the rate. */
  discountPaise: bigint;
  /** What the file gives as the line value before tax. */
  taxablePaise: bigint;
  /** GST rate in basis points, or null when it has to be worked out. */
  gstRateBp: number | null;
  /** Ad valorem cess in basis points. */
  cessBp: number;
}

export interface ImportDocument {
  source: ImportSource;
  /** Where it came from, for a report: a file line or a voucher number. */
  ref: string;
  type: DocumentType;
  number: string;
  /** ISO date. */
  date: string;
  partyName: string;
  partyGstin: string;
  /** State code of the place of supply, or empty. */
  placeOfSupply: string;
  reverseCharge: boolean;
  lines: ImportLine[];
  /** What the file says the document came to, for checking after the engine has worked it out. */
  fileTotalPaise: bigint | null;
  fileTaxPaise: bigint | null;
  narration: string;
}

export interface ImportPayment {
  source: ImportSource;
  ref: string;
  direction: 'received' | 'made';
  date: string;
  partyName: string;
  amountPaise: bigint;
  /** The bank or cash ledger or account the money went through, as the file names it. */
  account: string;
  reference: string;
}

export interface ImportIssue {
  severity: 'error' | 'warning' | 'info';
  ref: string;
  message: string;
}

export interface ImportBundle {
  source: ImportSource;
  parties: ImportParty[];
  items: ImportItem[];
  documents: ImportDocument[];
  payments: ImportPayment[];
  issues: ImportIssue[];
}

export const emptyBundle = (source: ImportSource): ImportBundle => ({
  source,
  parties: [],
  items: [],
  documents: [],
  payments: [],
  issues: [],
});
