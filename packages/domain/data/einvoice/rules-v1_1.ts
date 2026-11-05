/**
 * e-Invoice (IRN) rules, schema version 1.1, as data. The builder and the validator read these, so a
 * change by the Invoice Registration Portal is a change here.
 *
 * STATUS: written from the public documentation of the NIC e-invoice schema 1.1 and the CBIC
 * notifications as known when written. NOT verified against a sandbox: the first real run is recorded in
 * docs/compliance/einvoice-sandbox-run.md (B-111). Where the portal rejects something, fix it here.
 */
export interface EinvoiceRules {
  version: string;
  verified: boolean;
  /** Document number: 1 to 16 characters, letters, digits, "/" and "-"; not starting with 0, "/" or "-". */
  docNumber: RegExp;
  /** GST rates the portal accepts, in basis points. */
  gstRatesBp: readonly number[];
  /** Round-off must stay within this many paise either way. */
  maxRoundOffPaise: number;
  /** Line amounts may differ from the arithmetic by this many paise (the portal's own tolerance). */
  lineTolerancePaise: number;
  maxLines: number;
  lengths: Record<
    'legalName' | 'tradeName' | 'addr' | 'location' | 'description',
    [number, number]
  >;
  /** Pincode range; exports use 999999. */
  pincode: { min: number; max: number; export: number };
  /** IRN can be cancelled for this many hours after it is generated. */
  cancelHours: number;
  /** Cancellation reason codes of the portal. */
  cancelReasons: Record<'duplicate' | 'mistake' | 'orderCancelled' | 'other', string>;
  /**
   * Businesses with annual aggregate turnover at or above this (paise) may not report a document older
   * than `maxAgeDays` days, from `maxAgeFrom`.
   */
  ageLimit: { turnoverPaise: number; maxAgeDays: number; from: string };
  /** e-Invoicing applies from this aggregate turnover in any year since 2017-18 (paise). */
  applicableFromTurnoverPaise: number;
}

export const EINVOICE_RULES_V1_1: EinvoiceRules = {
  version: '1.1',
  verified: false,
  docNumber: /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/,
  gstRatesBp: [0, 10, 25, 100, 150, 300, 500, 600, 750, 1200, 1800, 2800, 4000],
  maxRoundOffPaise: 9_999,
  lineTolerancePaise: 100,
  maxLines: 1000,
  lengths: {
    legalName: [3, 100],
    tradeName: [3, 100],
    addr: [1, 100],
    location: [3, 50],
    description: [3, 300],
  },
  pincode: { min: 100000, max: 999999, export: 999999 },
  cancelHours: 24,
  cancelReasons: { duplicate: '1', mistake: '2', orderCancelled: '3', other: '4' },
  // Notification 10/2023-CT: INR 5 crore from 1 August 2023; the 30-day limit for INR 10 crore and above
  // from 1 April 2025 (GSTN advisory)
  ageLimit: { turnoverPaise: 10_00_00_000 * 100, maxAgeDays: 30, from: '2025-04-01' },
  applicableFromTurnoverPaise: 5_00_00_000 * 100,
};
