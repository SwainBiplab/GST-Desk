/**
 * e-Way Bill rules (rule 138 of the CGST Rules) as data.
 *
 * STATUS: written from the rule and the public e-way bill documentation as known when written. The
 * state-wise limits for movement inside a state change by state notification and are the least certain
 * part; each has `checked: false` until someone confirms it against the state's current notification
 * (B-112). NOT verified against a sandbox.
 */
export interface EwbRules {
  version: string;
  verified: boolean;
  /** Consignment value above which an e-way bill is needed (paise), unless a state sets its own. */
  thresholdPaise: number;
  /** State-specific limits for intra-state movement, by state code. */
  intraStateThresholds: Record<string, { paise: number; checked: boolean }>;
  /** Kilometres of validity per day: regular cargo and over-dimensional cargo. */
  kmPerDay: { regular: number; odc: number };
  /** An e-way bill can be cancelled for this many hours. */
  cancelHours: number;
  /** It can be extended from this many hours before to this many hours after it expires. */
  extendWindowHours: { before: number; after: number };
  /** Part B (the vehicle) is not needed within a state for up to this distance to the transporter. */
  partBExemptKm: number;
  maxDistanceKm: number;
  /** Document types of the e-way bill, by our document type. */
  docTypes: Record<string, string>;
  transModes: Record<'road' | 'rail' | 'air' | 'ship', string>;
  /** Vehicle number: state code, district, series, number, or a temporary or defence number. */
  vehicleNumber: RegExp;
}

export const EWB_RULES_V1: EwbRules = {
  version: 'v1',
  verified: false,
  thresholdPaise: 50_000 * 100,
  intraStateThresholds: {
    '07': { paise: 1_00_000 * 100, checked: false }, // Delhi
    '27': { paise: 1_00_000 * 100, checked: false }, // Maharashtra
    '33': { paise: 1_00_000 * 100, checked: false }, // Tamil Nadu
    '19': { paise: 1_00_000 * 100, checked: false }, // West Bengal
  },
  kmPerDay: { regular: 200, odc: 20 },
  cancelHours: 24,
  extendWindowHours: { before: 8, after: 8 },
  partBExemptKm: 50,
  maxDistanceKm: 4000,
  docTypes: {
    tax_invoice: 'INV',
    bill_of_supply: 'BIL',
    delivery_challan: 'CHL',
    credit_note: 'OTH',
    debit_note: 'OTH',
    purchase_bill: 'INV',
    purchase_return: 'OTH',
  },
  transModes: { road: '1', rail: '2', air: '3', ship: '4' },
  vehicleNumber:
    /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|TR[A-Z0-9]{5,12}|[0-9]{2}[A-Z][0-9]{6}[A-Z])$/,
};
