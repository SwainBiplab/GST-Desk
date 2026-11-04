/**
 * Composition scheme rules (CGST Act s.10, Rule 46A): a composition taxable person issues a bill of
 * supply carrying a declaration, never a tax invoice, and cannot collect tax from the buyer.
 */
import type { DocumentType } from './turnover';

export type Scheme = 'regular' | 'composition';

/** Wording required on every bill of supply issued by a composition dealer (Rule 46A). */
export const RULE_46A_DECLARATION =
  'Composition taxable person, not eligible to collect tax on supplies';

export type IssueCheck = { ok: true } | { ok: false; reason: string };

/** Types a composition business may not issue, with the reason shown to the user. */
const BLOCKED: Partial<Record<DocumentType, string>> = {
  tax_invoice:
    'A business under the composition scheme cannot issue tax invoices or collect GST from customers (CGST Act s.10). Use a Bill of Supply instead.',
};

export function canIssue(type: DocumentType, scheme: Scheme): IssueCheck {
  if (scheme === 'composition') {
    const reason = BLOCKED[type];
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

/** The document type a business should reach for first when it sells. */
export function defaultSaleType(scheme: Scheme): DocumentType {
  return scheme === 'composition' ? 'bill_of_supply' : 'tax_invoice';
}

/** Text to print on a document, or null when none is required. */
export function declarationFor(type: DocumentType, scheme: Scheme): string | null {
  return scheme === 'composition' && type === 'bill_of_supply' ? RULE_46A_DECLARATION : null;
}
