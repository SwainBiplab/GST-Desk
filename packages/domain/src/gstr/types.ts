/** Inputs and outputs of the GSTR-1 and GSTR-3B builders. Money is integer paise, quantity micro-units, rates basis points. */

export type GstrDocType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'credit_note'
  | 'debit_note'
  | 'receipt_voucher'
  | 'delivery_challan'
  | 'purchase_bill'
  | 'purchase_return'
  | 'rcm_self_invoice';

export type GstrTaxability = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';

export interface GstrLine {
  hsn: string;
  description: string;
  /** Unique Quantity Code, "OTH" when the unit has none. */
  uqc: string;
  qtyMicros: number;
  taxablePaise: number;
  /** CGST + SGST (or UTGST) or IGST rate in basis points, whichever heads the line carries. */
  rateBp: number;
  igstPaise: number;
  cgstPaise: number;
  /** State or union-territory tax (SGST and UTGST are reported together). */
  sgstPaise: number;
  cessPaise: number;
  taxability: GstrTaxability;
}

/** What the builders need to know about one issued or cancelled document. */
export interface GstrDoc {
  id: string;
  type: GstrDocType;
  status: 'issued' | 'cancelled';
  number: string;
  /** Series the number came from (counters of one logical series share it). */
  seriesKey: string;
  /** YYYY-MM-DD in Asia/Kolkata. */
  date: string;
  partyName: string;
  partyGstin: string;
  /** Registered party (has a GSTIN and is not marked unregistered). */
  registered: boolean;
  partyComposition: boolean;
  partyState: string;
  /** Two-digit place-of-supply code, `96` for a foreign country. */
  pos: string;
  /** The supplier's own state (the business). */
  supplierState: string;
  supplyType: 'intra' | 'inter' | 'export' | 'sez';
  /** Export or SEZ supply under LUT/bond: no IGST charged. */
  lut: boolean;
  reverseCharge: boolean;
  totalPaise: number;
  /** For a note: the invoice it corrects. */
  linkedNumber: string;
  linkedDate: string;
  /** For a note: the value of the invoice it corrects (decides B2CL or B2CS treatment). 0 when unknown. */
  linkedTotalPaise: number;
  lines: GstrLine[];
}

export interface GstrPeriod {
  gstin: string;
  /** MMYYYY, the key used in the GSTN files. For a quarter, the last month of it. */
  fp: string;
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
  kind: 'month' | 'quarter';
}

/** Tax amounts of one row, in paise. */
export interface TaxAmounts {
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface RateRow extends TaxAmounts {
  /** Rate in basis points. */
  rateBp: number;
}

export interface B2bInvoice {
  docId: string;
  inum: string;
  idt: string;
  val: number;
  pos: string;
  rchrg: boolean;
  invTyp: string;
  items: RateRow[];
}
export interface B2bParty {
  ctin: string;
  name: string;
  invoices: B2bInvoice[];
}

export interface B2cl {
  pos: string;
  invoices: { docId: string; inum: string; idt: string; val: number; items: RateRow[] }[];
}

export interface B2csRow extends RateRow {
  pos: string;
}

export interface NoteRow {
  docId: string;
  ntty: 'C' | 'D';
  num: string;
  dt: string;
  val: number;
  pos: string;
  rchrg: boolean;
  invTyp: string;
  /** The invoice the note refers to, for the reviewer (not written to the file). */
  linked: string;
  items: RateRow[];
}
export interface CdnrParty {
  ctin: string;
  name: string;
  notes: NoteRow[];
}
export interface CdnurRow {
  docId: string;
  typ: string;
  ntty: 'C' | 'D';
  num: string;
  dt: string;
  val: number;
  pos: string;
  items: RateRow[];
}

export interface ExpInvoice {
  docId: string;
  inum: string;
  idt: string;
  val: number;
  items: RateRow[];
}
export interface ExpGroup {
  expTyp: string;
  invoices: ExpInvoice[];
}

export interface NilRow {
  splyTy: string;
  exptAmt: number;
  nilAmt: number;
  ngsupAmt: number;
}

export interface GstrHsnRow {
  hsn: string;
  description: string;
  uqc: string;
  qtyMicros: number;
  /** Total invoice value of the lines (taxable + tax). */
  val: number;
  rateBp: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface DocRange {
  docNum: number;
  docTyp: string;
  from: string;
  to: string;
  totnum: number;
  cancel: number;
  netIssue: number;
}

export interface Gstr1 {
  period: GstrPeriod;
  b2b: B2bParty[];
  b2cl: B2cl[];
  b2cs: B2csRow[];
  cdnr: CdnrParty[];
  cdnur: CdnurRow[];
  exp: ExpGroup[];
  nil: NilRow[];
  hsnB2b: GstrHsnRow[];
  hsnB2c: GstrHsnRow[];
  docs: DocRange[];
  /** Taxable lines counted into tables 4 to 9, net of credit notes, for the reconciliation. */
  totals: TaxAmounts;
  /** Value of nil-rated, exempt and non-GST lines in table 8 (net of credit notes). */
  nilTotalPaise: number;
  /** Value of lines that no table can carry (nil, exempt or non-GST lines of exports and SEZ supplies). */
  unplacedPaise: number;
  /** Issues found while building (the validator adds more). */
  issues: GstrIssue[];
}

export type IssueSeverity = 'error' | 'warning';
export interface GstrIssue {
  severity: IssueSeverity;
  /** Stable code, also the inbox item's key. */
  code: string;
  table: string;
  docId?: string;
  message: string;
}

/** GSTR-3B */
export interface Gstr3b {
  period: GstrPeriod;
  /** 3.1(a) outward taxable, (b) zero rated, (c) nil and exempt, (d) inward reverse charge, (e) non-GST. */
  s31: { a: TaxAmounts; b: TaxAmounts; c: TaxAmounts; d: TaxAmounts; e: TaxAmounts };
  /** 3.2 inter-state supplies to unregistered persons and composition dealers, by place of supply. */
  s32: {
    unreg: { pos: string; txval: number; iamt: number }[];
    composition: { pos: string; txval: number; iamt: number }[];
  };
  /** 4: ITC. Every row is IGST, CGST, SGST, cess in paise. */
  s4: {
    availableImportGoods: Tax4;
    availableImportServices: Tax4;
    availableReverseCharge: Tax4;
    availableIsd: Tax4;
    availableOther: Tax4;
    reversedRules: Tax4;
    reversedOther: Tax4;
    net: Tax4;
    ineligibleRules: Tax4;
    ineligibleOther: Tax4;
  };
  /** 5: inward supplies from exempt, nil-rated and non-GST sources. */
  s5: { gst: { inter: number; intra: number }; nonGst: { inter: number; intra: number } };
  /** 6.1: payment of tax (an estimate: liability less credit, by the utilisation order). */
  s61: PaymentEstimate;
}

export interface Tax4 {
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface PaymentEstimate {
  liability: Tax4;
  creditUsed: Tax4;
  cashPayable: Tax4;
  /** Credit left over after setting off the liability. */
  creditCarried: Tax4;
}

/** An edit of an ITC (or other) field by a person, kept with who and why. */
export interface PeriodAdjustment {
  /** `itc.availableOther`, `itc.reversedRules`, ... */
  field: string;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
  reason: string;
}

export const ZERO_TAX: TaxAmounts = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
export const ZERO_4: Tax4 = { iamt: 0, camt: 0, samt: 0, csamt: 0 };
