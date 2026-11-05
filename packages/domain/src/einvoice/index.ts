export * from './types';
export * from './payload';
export * from './ewb';
export { EINVOICE_RULES_V1_1, type EinvoiceRules } from '../../data/einvoice/rules-v1_1';
export { EWB_RULES_V1, type EwbRules } from '../../data/ewb-rules';
export { GSP_ERRORS, explainGspError, type GspErrorInfo } from '../../data/gsp-errors';

/** Document types an IRN is made for. */
export const EINVOICE_TYPES = ['tax_invoice', 'credit_note', 'debit_note'] as const;

/**
 * Whether a document needs an IRN: the business has e-invoicing on, the document is an invoice or a
 * note, and it goes to a registered buyer, an SEZ unit or abroad (not to a consumer).
 */
export function needsIrn(d: {
  einvoicingOn: boolean;
  type: string;
  status: string;
  registered: boolean;
  supplyType: string;
}): boolean {
  if (!d.einvoicingOn || d.status !== 'issued') return false;
  if (!(EINVOICE_TYPES as readonly string[]).includes(d.type)) return false;
  return d.registered || d.supplyType === 'export' || d.supplyType === 'sez';
}
