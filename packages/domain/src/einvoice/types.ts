/** Inputs of the e-invoice and e-way bill builders. Money is integer paise, quantity micro-units, rates basis points. */

export type EinvSupply = 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' | 'DEXP';
export type EinvDocKind = 'INV' | 'CRN' | 'DBN';

export interface EinvParty {
  gstin: string;
  legalName: string;
  tradeName?: string | undefined;
  addr1: string;
  addr2?: string | undefined;
  location: string;
  pincode: string;
  stateCode: string;
  phone?: string | undefined;
  email?: string | undefined;
}

export interface EinvLine {
  description: string;
  hsn: string;
  qtyMicros: number;
  /** Unique Quantity Code. */
  uqc: string;
  /** Price of one unit, before discount and tax. */
  unitPricePaise: number;
  /** Quantity times unit price. */
  grossPaise: number;
  discountPaise: number;
  /** After discount: the assessable value. */
  taxablePaise: number;
  /** IGST rate, or CGST plus SGST rate. */
  gstRateBp: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessRateBp: number;
  cessPaise: number;
  otherChargesPaise: number;
  totalPaise: number;
}

export interface EinvDoc {
  kind: EinvDocKind;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  supply: EinvSupply;
  reverseCharge: boolean;
  seller: EinvParty;
  /** The buyer, with the place of supply. For an export the GSTIN is `URP` and the pincode 999999. */
  buyer: EinvParty & { pos: string };
  shipTo?: EinvParty | null;
  lines: EinvLine[];
  totals: {
    assessablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    /** Discount on the whole invoice (not on lines). */
    discountPaise: number;
    otherChargesPaise: number;
    roundOffPaise: number;
    totalPaise: number;
  };
  /** For a credit or debit note: the invoice it corrects. */
  preceding?: { number: string; date: string } | null;
  exportDetails?: {
    shippingBillNo?: string;
    shippingBillDate?: string;
    portCode?: string;
    currency?: string;
    countryCode?: string;
  } | null;
}

export interface EinvProblem {
  /** Where in the payload, for example `ItemList[2].HsnCd`. */
  path: string;
  code: string;
  message: string;
}

/** What the portal returns for a generated IRN. */
export interface IrnResult {
  irn: string;
  ackNo: string;
  /** As the portal gives it (`YYYY-MM-DD HH:mm:ss`, IST). */
  ackDate: string;
  signedInvoice: string;
  signedQr: string;
  /** Set when the e-way bill was generated with the IRN. */
  ewbNo?: string | null;
  ewbValidUntil?: string | null;
}
