/**
 * Standard due dates for GSTR-1 and GSTR-3B, as data. These are the dates in the law's default rules;
 * the Government often extends a month's date by notification and those extensions are NOT included.
 * A business can override any date in Settings (the Filing Desk shows an override as "set by you").
 * Reconstructed from the standard rules and not verified by a chartered accountant (backlog B-097).
 */
export interface DueDateRules {
  version: string;
  verified: boolean;
  /** Day of the month after the period (monthly filers). */
  monthly: { gstr1Day: number; gstr3bDay: number };
  /** Quarterly filers (QRMP): the day of the month after the quarter. */
  quarterly: { gstr1Day: number; gstr3bDayGroupX: number; gstr3bDayGroupY: number };
  /**
   * State codes whose quarterly GSTR-3B is due on the earlier day ("category X" states); every other
   * state uses the later day.
   */
  groupXStates: string[];
}

export const DUE_DATE_RULES_V1: DueDateRules = {
  version: 'v1',
  verified: false,
  monthly: { gstr1Day: 11, gstr3bDay: 20 },
  quarterly: { gstr1Day: 13, gstr3bDayGroupX: 22, gstr3bDayGroupY: 24 },
  groupXStates: [
    '22', // Chhattisgarh
    '23', // Madhya Pradesh
    '24', // Gujarat
    '26', // Dadra and Nagar Haveli and Daman and Diu
    '27', // Maharashtra
    '29', // Karnataka
    '30', // Goa
    '31', // Lakshadweep
    '32', // Kerala
    '33', // Tamil Nadu
    '34', // Puducherry
    '35', // Andaman and Nicobar Islands
    '36', // Telangana
    '37', // Andhra Pradesh
  ],
};
