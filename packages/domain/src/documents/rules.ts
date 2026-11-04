/**
 * Document rules that do not involve money: what may be issued, due dates, which document converts
 * into which, and how a conversion maps lines. Pure TypeScript.
 */
import { canIssue, type Scheme } from '../composition';
import { isValidStateCode } from '../tax/supply';
import type { DocumentType } from '../turnover';

import {
  buildDocument,
  isBlankLine,
  isFilledLine,
  type BuiltDocument,
  type DraftDocument,
  type DraftLine,
} from './build';

export interface DraftIssue {
  field: string;
  code: string;
  /** Zero-based grid row, for line problems. */
  line?: number;
}

export interface ValidationContext {
  /** Business scheme: a composition business cannot issue tax invoices. */
  scheme: Scheme;
  /** Tax invoices above this total need the customer's GSTIN. 0 or omitted: never required. */
  gstinRequiredAbovePaise?: bigint;
  /** Dates before this are in a closed period. */
  openFrom?: string;
  /** Dates after this (usually today) are not allowed. */
  openTo?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | null): s is string =>
  !!s && ISO.test(s) && !Number.isNaN(Date.parse(s));

/** Types that always name a party. A tax invoice or bill of supply may be a cash sale. */
const NEEDS_PARTY: ReadonlySet<DocumentType> = new Set([
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'purchase_bill',
  'purchase_return',
]);

/** Types that carry no tax of their own to collect, so a zero total is still a document. */
const ZERO_OK: ReadonlySet<DocumentType> = new Set(['delivery_challan']);

/**
 * Everything that stops a draft being issued. Saving a draft only needs `blank` to be false: a draft
 * may be incomplete. Returns an empty array when the document can be issued.
 */
export function validateForIssue(
  d: DraftDocument,
  ctx: ValidationContext,
  /** The draft already priced, when the caller has it: saves pricing every line a second time. */
  priced?: BuiltDocument,
): DraftIssue[] {
  const out: DraftIssue[] = [];
  const add = (field: string, code: string, line?: number) =>
    out.push(line === undefined ? { field, code } : { field, code, line });

  const kept = d.lines.filter((l) => !isBlankLine(l));
  if (kept.length === 0) {
    add('lines', 'no_lines');
  } else {
    d.lines.forEach((l, i) => {
      if (isBlankLine(l)) return;
      if (l.itemId === null && l.description.trim() === '') add('lines', 'line_description', i);
      if (l.qtyMicros <= 0n) add('lines', 'line_qty', i);
      if (l.ratePaise < 0n) add('lines', 'line_rate', i);
    });
    if (!kept.some(isFilledLine)) add('lines', 'no_lines');
  }

  if (!validDate(d.date)) add('date', 'date');
  else {
    if (ctx.openFrom && d.date < ctx.openFrom) add('date', 'date_closed_period');
    if (ctx.openTo && d.date > ctx.openTo) add('date', 'date_future');
  }
  if (d.dueDate !== null && validDate(d.dueDate) && validDate(d.date) && d.dueDate < d.date)
    add('dueDate', 'due_before_date');
  if (d.dueDate !== null && !validDate(d.dueDate)) add('dueDate', 'date');

  if (!d.placeOfSupply || (!d.export && !isValidStateCode(d.placeOfSupply)))
    add('placeOfSupply', 'pos_required');
  if (d.export && d.placeOfSupply !== '96') add('placeOfSupply', 'export_pos');
  if (!d.supplierState) add('supplierState', 'supplier_state');

  if (NEEDS_PARTY.has(d.type) && d.partyId === null) add('party', 'party_required');

  if (d.currency !== 'INR' && d.fxRateMicros <= 0n) add('fxRateMicros', 'fx_rate');

  if (d.type === 'purchase_bill') {
    if (d.supplierInvoiceNo.trim() === '') add('supplierInvoiceNo', 'supplier_invoice_no');
    if (!validDate(d.supplierInvoiceDate)) add('supplierInvoiceDate', 'date');
  }

  const allowed = canIssue(d.type, ctx.scheme);
  if (!allowed.ok) add('type', 'composition_blocked');

  if (kept.length > 0 && out.every((i) => i.field !== 'lines')) {
    const built = priced ?? buildDocument(d);
    if (built.totals.totalPaise <= 0n && !ZERO_OK.has(d.type)) add('lines', 'zero_total');
    const above = ctx.gstinRequiredAbovePaise ?? 0n;
    if (
      above > 0n &&
      d.type === 'tax_invoice' &&
      d.partyId !== null &&
      !d.partyGstin &&
      !d.export &&
      built.totals.totalPaise > above
    )
      add('party', 'gstin_required');
  }
  return out;
}

/** True when saving even a draft makes no sense: nothing typed anywhere. */
export function isBlankDraft(d: DraftDocument): boolean {
  return (
    d.lines.every(isBlankLine) &&
    d.partyId === null &&
    d.partyName.trim() === '' &&
    d.notes.trim() === '' &&
    d.supplierInvoiceNo.trim() === ''
  );
}

/** `date` plus `days` calendar days, as an ISO date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date from a party's credit days. No credit days means due on the document date. */
export const dueDateFor = (date: string, creditDays: number): string | null =>
  creditDays > 0 ? addDays(date, creditDays) : null;

/* ------------------------------------------------------------------ conversions */

/** What each document type may be converted into (FR-034). */
export const CONVERSIONS: Partial<Record<DocumentType, readonly DocumentType[]>> = {
  quotation: ['tax_invoice', 'bill_of_supply', 'proforma'],
  proforma: ['tax_invoice', 'bill_of_supply'],
  delivery_challan: ['tax_invoice', 'bill_of_supply'],
  tax_invoice: ['credit_note', 'debit_note'],
  bill_of_supply: ['credit_note', 'debit_note'],
  purchase_bill: ['purchase_return'],
};

export const canConvert = (from: DocumentType, to: DocumentType): boolean =>
  CONVERSIONS[from]?.includes(to) ?? false;

export interface LineSelection {
  key: string;
  /** Quantity to carry over, in micro-units. Must not exceed the source line. */
  qtyMicros: bigint;
}

export class ConversionError extends Error {
  override name = 'ConversionError';
}

/** Credit and debit notes and purchase returns reverse part or all of an earlier document. */
export const isAdjustment = (type: DocumentType): boolean =>
  type === 'credit_note' || type === 'debit_note' || type === 'purchase_return';

/**
 * A new draft that carries over what the source holds. Dates, number, due date, payments and TCS
 * start fresh. For an adjustment, pass `selection` to take only some lines or part quantities.
 */
export function convertDraft(
  source: DraftDocument,
  target: DocumentType,
  today: string,
  newKey: () => string,
  selection?: readonly LineSelection[],
): DraftDocument {
  if (!canConvert(source.type, target))
    throw new ConversionError(`a ${source.type} cannot be converted into a ${target}`);

  let lines: DraftLine[] = source.lines.filter((l) => !isBlankLine(l));
  if (selection) {
    const picked = new Map(selection.map((s) => [s.key, s.qtyMicros]));
    lines = lines
      .filter((l) => picked.has(l.key))
      .map((l) => {
        const qty = picked.get(l.key)!;
        if (qty <= 0n || qty > l.qtyMicros)
          throw new ConversionError(
            `quantity for "${l.description}" must be between 0 and the original`,
          );
        return { ...l, qtyMicros: qty };
      });
    if (lines.length === 0) throw new ConversionError('select at least one line');
  }
  return {
    ...source,
    type: target,
    date: today,
    dueDate: null,
    lines: lines.map((l) => ({ ...l, key: newKey() })),
    tcs: null,
    tds: null,
    // a bill of supply has no tax to collect; keep the lines and let the engine price them
    refs: { ...source.refs },
  };
}

/** A copy that starts a new draft of the same type. */
export function duplicateDraft(
  source: DraftDocument,
  today: string,
  newKey: () => string,
): DraftDocument {
  return {
    ...source,
    date: today,
    dueDate: null,
    lines: source.lines.map((l) => ({ ...l, key: newKey() })),
    supplierInvoiceNo: '',
    supplierInvoiceDate: null,
  };
}

/**
 * Stock movement a document causes when it is issued: `out` takes stock from the godown, `in` adds
 * to it. Quotations, proformas, challans and expenses move no stock here.
 */
export function stockEffect(type: DocumentType): 'in' | 'out' | null {
  switch (type) {
    case 'tax_invoice':
    case 'bill_of_supply':
    case 'debit_note':
    case 'purchase_return':
      return 'out';
    case 'purchase_bill':
    case 'credit_note':
      return 'in';
    default:
      return null;
  }
}

/** Types whose issue creates a ledger posting. Quotations, proformas and challans are not accounting documents. */
export const POSTS_TO_LEDGER: ReadonlySet<DocumentType> = new Set([
  'tax_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'purchase_bill',
  'purchase_return',
  'expense',
]);
