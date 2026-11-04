/** Place-of-supply classification and tax-head selection (IGST Act s.7, 8, 10-13; CGST Act s.8-9; UTGST Act s.7-8). */

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

/** Place-of-supply code used for exports (GSTN convention: 96 = foreign country). */
export const FOREIGN_POS = '96';

/**
 * Union territories without a legislature: intra-UT supplies carry CGST + UTGST.
 * Delhi (07), Puducherry (34) and Jammu and Kashmir (01) have legislatures and use SGST.
 */
export const UTGST_TERRITORIES = new Set(['04', '26', '31', '35', '38']);

export type SupplyType =
  'intra' | 'inter' | 'export' | 'sez_with_tax' | 'sez_without_tax' | 'deemed_export';

export interface PartyFlags {
  /** Recipient is an SEZ unit or developer. */
  sez?: boolean;
  /** Supply is under LUT/bond (SEZ or export without payment of IGST). */
  lut?: boolean;
  export?: boolean;
  deemedExport?: boolean;
}

export function isValidStateCode(code: string): boolean {
  return Object.hasOwn(STATES, code) || code === FOREIGN_POS;
}

export function supplyType(
  supplierState: string,
  placeOfSupply: string,
  flags: PartyFlags = {},
): SupplyType {
  if (flags.export || placeOfSupply === FOREIGN_POS) return 'export';
  if (flags.deemedExport) return 'deemed_export';
  if (flags.sez) return flags.lut ? 'sez_without_tax' : 'sez_with_tax';
  return supplierState === placeOfSupply ? 'intra' : 'inter';
}

export type TaxHeads = 'cgst_sgst' | 'cgst_utgst' | 'igst' | 'none';

/** Which GST heads a supply carries. `none` = zero-rated without payment of tax (LUT). */
export function taxHeadsFor(
  type: SupplyType,
  supplierState: string,
  flags: PartyFlags = {},
): TaxHeads {
  switch (type) {
    case 'intra':
      return UTGST_TERRITORIES.has(supplierState) ? 'cgst_utgst' : 'cgst_sgst';
    case 'inter':
    case 'sez_with_tax':
    case 'deemed_export':
      return 'igst';
    case 'sez_without_tax':
      return 'none';
    case 'export':
      return flags.lut ? 'none' : 'igst';
  }
}
