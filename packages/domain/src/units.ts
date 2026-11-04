/**
 * Units of measure. GST returns use the Unique Quantity Codes (UQC) listed by the GST Network;
 * a business may define its own units, each mapped to one UQC for returns.
 */
import { mulDivRound } from './money';

/** [code, name] for every UQC accepted in GST returns and e-invoices. */
export const UQC_MASTER = [
  ['BAG', 'Bags'],
  ['BAL', 'Bale'],
  ['BDL', 'Bundles'],
  ['BKL', 'Buckles'],
  ['BOU', 'Billions of units'],
  ['BOX', 'Box'],
  ['BTL', 'Bottles'],
  ['BUN', 'Bunches'],
  ['CAN', 'Cans'],
  ['CBM', 'Cubic meters'],
  ['CCM', 'Cubic centimeters'],
  ['CMS', 'Centimeters'],
  ['CTN', 'Cartons'],
  ['DOZ', 'Dozens'],
  ['DRM', 'Drums'],
  ['GGK', 'Great gross'],
  ['GMS', 'Grammes'],
  ['GRS', 'Gross'],
  ['GYD', 'Gross yards'],
  ['KGS', 'Kilograms'],
  ['KLR', 'Kilolitre'],
  ['KME', 'Kilometre'],
  ['LTR', 'Litres'],
  ['MLT', 'Millilitre'],
  ['MTR', 'Meters'],
  ['MTS', 'Metric ton'],
  ['NOS', 'Numbers'],
  ['OTH', 'Others'],
  ['PAC', 'Packs'],
  ['PCS', 'Pieces'],
  ['PRS', 'Pairs'],
  ['QTL', 'Quintal'],
  ['ROL', 'Rolls'],
  ['SET', 'Sets'],
  ['SQF', 'Square feet'],
  ['SQM', 'Square meters'],
  ['SQY', 'Square yards'],
  ['TBS', 'Tablets'],
  ['TGM', 'Ten gross'],
  ['THD', 'Thousands'],
  ['TON', 'Tonnes'],
  ['TUB', 'Tubes'],
  ['UGS', 'US gallons'],
  ['UNT', 'Units'],
  ['YDS', 'Yards'],
] as const;

export type UqcCode = (typeof UQC_MASTER)[number][0];

const UQC_NAMES: ReadonlyMap<string, string> = new Map(UQC_MASTER);

export const isUqc = (code: string): code is UqcCode => UQC_NAMES.has(code);
export const uqcName = (code: string): string | null => UQC_NAMES.get(code) ?? null;

/** The units a new business starts with. */
export const DEFAULT_UNIT_CODES: readonly UqcCode[] = [
  'NOS',
  'KGS',
  'GMS',
  'LTR',
  'MTR',
  'BOX',
  'PCS',
  'SET',
  'DOZ',
  'OTH',
];

export interface UnitLike {
  code: string;
  uqc?: string | null;
  is_custom?: boolean | null;
}

/**
 * The UQC to report for a unit in returns. A standard unit reports itself; a custom unit reports
 * the UQC it was mapped to; an unmapped custom unit reports `OTH`.
 */
export function returnsUqc(unit: UnitLike): UqcCode {
  if (unit.uqc && isUqc(unit.uqc)) return unit.uqc;
  if (!unit.is_custom && isUqc(unit.code)) return unit.code;
  return 'OTH';
}

export type UnitCheck = 'code' | 'name' | 'uqc' | 'duplicate';

/** Validate a custom unit: a short upper-case code, a name, and a UQC to report as. */
export function validateCustomUnit(
  input: { code: string; name: string; uqc: string },
  existingCodes: Iterable<string> = [],
): UnitCheck[] {
  const out: UnitCheck[] = [];
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) out.push('code');
  else if ([...existingCodes].some((c) => c.toUpperCase() === code)) out.push('duplicate');
  if (input.name.trim() === '') out.push('name');
  if (!isUqc(input.uqc)) out.push('uqc');
  return out;
}

/**
 * Convert a quantity in the secondary unit to the primary unit. `factorMicros` is how many
 * primary units make one secondary unit, in micro-units (1 box = 12 numbers is 12_000_000).
 */
export function toPrimaryMicros(secondaryQtyMicros: bigint, factorMicros: bigint): bigint {
  return mulDivRound(secondaryQtyMicros, factorMicros, 1_000_000n);
}

/** The reverse of `toPrimaryMicros`. */
export function toSecondaryMicros(primaryQtyMicros: bigint, factorMicros: bigint): bigint {
  if (factorMicros <= 0n) throw new RangeError('conversion factor must be positive');
  return mulDivRound(primaryQtyMicros, 1_000_000n, factorMicros);
}
