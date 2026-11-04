/**
 * Business presets and the feature flags derived from them (FR-005). A preset picks sensible
 * defaults; a business can override single flags, and the tax scheme can force some off.
 */
import type { DocumentType } from './turnover';

export const PRESET_IDS = [
  'freelancer',
  'retail',
  'services',
  'trader',
  'manufacturer',
  'ca_firm',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface FeatureFlags {
  /** Track stock: movements, godowns, low-stock alerts. */
  inventory: boolean;
  /** Thermal (receipt) printing and POS-style billing. */
  thermal: boolean;
  /** Purchase bills and supplier workflows. */
  purchases: boolean;
  quotations: boolean;
  challans: boolean;
  expenses: boolean;
  /** May issue tax invoices (false for composition businesses). */
  taxInvoice: boolean;
  /** Bill of supply (composition and exempt-only businesses). */
  billOfSupply: boolean;
}

export type FlagKey = keyof FeatureFlags;
export const FLAG_KEYS: FlagKey[] = [
  'inventory',
  'thermal',
  'purchases',
  'quotations',
  'challans',
  'expenses',
  'taxInvoice',
  'billOfSupply',
];

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  /** Document types offered first when creating a document. */
  documentTypes: DocumentType[];
  /** Print template id (templates arrive in prompt 17). */
  printTemplate: string;
  /** UQC codes enabled for this kind of business. */
  units: string[];
  flags: FeatureFlags;
}

const base: FeatureFlags = {
  inventory: false,
  thermal: false,
  purchases: true,
  quotations: true,
  challans: false,
  expenses: true,
  taxInvoice: true,
  billOfSupply: false,
};

export const PRESETS: Record<PresetId, Preset> = {
  freelancer: {
    id: 'freelancer',
    label: 'Freelancer',
    description: 'You sell your time or skills. Invoices and quotations, no stock.',
    documentTypes: ['tax_invoice', 'quotation', 'receipt_voucher', 'credit_note'],
    printTemplate: 'a4-clean',
    units: ['OTH', 'NOS'],
    flags: { ...base, purchases: false },
  },
  retail: {
    id: 'retail',
    label: 'Retail shop',
    description: 'Counter sales with receipts, barcode and stock.',
    documentTypes: ['tax_invoice', 'bill_of_supply', 'credit_note', 'purchase_bill'],
    printTemplate: 'thermal-80',
    units: ['NOS', 'PCS', 'KGS', 'GMS', 'LTR', 'BOX', 'DOZ'],
    flags: { ...base, inventory: true, thermal: true, quotations: false },
  },
  services: {
    id: 'services',
    label: 'Service business',
    description: 'Agencies, clinics, repair and similar. Quotations and invoices, light purchases.',
    documentTypes: ['quotation', 'tax_invoice', 'receipt_voucher', 'expense'],
    printTemplate: 'a4-clean',
    units: ['OTH', 'NOS', 'SET'],
    flags: { ...base },
  },
  trader: {
    id: 'trader',
    label: 'Trader or wholesaler',
    description: 'Buy and sell goods with stock, challans and credit customers.',
    documentTypes: [
      'tax_invoice',
      'quotation',
      'delivery_challan',
      'purchase_bill',
      'credit_note',
      'debit_note',
    ],
    printTemplate: 'a4-classic',
    units: ['NOS', 'PCS', 'KGS', 'MTR', 'BOX', 'SET', 'DOZ'],
    flags: { ...base, inventory: true, challans: true },
  },
  manufacturer: {
    id: 'manufacturer',
    label: 'Manufacturer',
    description: 'Raw material in, finished goods out. Stock, batches and challans.',
    documentTypes: [
      'tax_invoice',
      'delivery_challan',
      'purchase_bill',
      'purchase_return',
      'credit_note',
      'debit_note',
    ],
    printTemplate: 'a4-classic',
    units: ['NOS', 'KGS', 'MTR', 'LTR', 'BOX', 'SET', 'OTH'],
    flags: { ...base, inventory: true, challans: true },
  },
  ca_firm: {
    id: 'ca_firm',
    label: 'CA or accounting firm',
    description: 'You serve other businesses. Invoices for your fees; client portals come later.',
    documentTypes: ['tax_invoice', 'quotation', 'receipt_voucher', 'expense'],
    printTemplate: 'a4-clean',
    units: ['OTH', 'NOS'],
    flags: { ...base, purchases: false },
  },
};

export const isPresetId = (v: unknown): v is PresetId =>
  (PRESET_IDS as readonly unknown[]).includes(v);

/**
 * Effective flags: preset defaults, then manual overrides, then the tax scheme has the last word
 * (a composition business cannot issue tax invoices, whatever the overrides say).
 */
export function deriveFlags(
  preset: PresetId | null | undefined,
  scheme: 'regular' | 'composition' = 'regular',
  overrides: Partial<FeatureFlags> = {},
): FeatureFlags {
  const flags: FeatureFlags = { ...(preset ? PRESETS[preset].flags : base), ...overrides };
  if (scheme === 'composition') {
    flags.taxInvoice = false;
    flags.billOfSupply = true;
  }
  return flags;
}

/** Overrides that differ from what the preset would give: only these are worth storing. */
export function diffOverrides(
  preset: PresetId | null | undefined,
  scheme: 'regular' | 'composition',
  wanted: FeatureFlags,
): Partial<FeatureFlags> {
  const defaults = deriveFlags(preset, scheme);
  const out: Partial<FeatureFlags> = {};
  for (const k of FLAG_KEYS) if (wanted[k] !== defaults[k]) out[k] = wanted[k];
  return out;
}
