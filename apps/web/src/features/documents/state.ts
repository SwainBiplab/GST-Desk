/**
 * The document editor's state, as pure functions: applying a party or an item to the draft, turning a
 * grid cell into text and back, and keeping one blank row at the end for typing into. No React, no
 * database: everything here is unit-tested. Money always goes through `buildDocument` in `@gst/domain`.
 */
import type { Row } from '@gst/db';
import {
  GST_RATES_BP,
  dueDateFor,
  emptyDraftLine,
  isBlankLine,
  parseAmountPaise,
  parseQtyMicros,
  parseRateBp,
  toDecimalString,
  type BuiltLine,
  type DraftDocument,
  type DraftLine,
  type DocumentType,
  type DraftIssue,
} from '@gst/domain';

import { impliedRateBp, type BillPrefill } from '../gst/prefill';

export const GRID_COLUMNS = [
  'item',
  'hsn',
  'qty',
  'unit',
  'rate',
  'incl',
  'discount',
  'taxable',
  'taxRate',
  'tax',
  'total',
  'note',
] as const;
export type GridColumn = (typeof GRID_COLUMNS)[number];

/** Columns the user can type into. The rest are computed by the engine. */
export const EDITABLE: ReadonlySet<GridColumn> = new Set([
  'item',
  'hsn',
  'qty',
  'unit',
  'rate',
  'incl',
  'discount',
  'taxRate',
  'note',
]);

export const DEFAULT_HIDDEN: readonly GridColumn[] = ['note'];

/** Purchases are priced at what the supplier charges; everything else at the sale price. */
export const isPurchase = (t: DocumentType): boolean =>
  t === 'purchase_bill' || t === 'purchase_return' || t === 'expense';

let counter = 0;
/** A key for a new grid row. Stable for the life of the editor. */
export const newLineKey = (): string => `ln${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Make sure the draft ends with exactly one blank row to type into. */
export function withTrailingBlank(d: DraftDocument): DraftDocument {
  const lines = [...d.lines];
  while (
    lines.length > 1 &&
    isBlankLine(lines[lines.length - 1]!) &&
    isBlankLine(lines[lines.length - 2]!)
  )
    lines.pop();
  const last = lines[lines.length - 1];
  if (!last || !isBlankLine(last)) lines.push(emptyDraftLine(newLineKey()));
  return lines.length === d.lines.length && lines.every((l, i) => l === d.lines[i])
    ? d
    : { ...d, lines };
}

const trim = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Apply a chosen item to a row: name, HSN, unit, rate, GST rate, cess and whether its price includes
 * tax. Keeps the quantity the user already typed. A service has no HSN requirement here.
 */
export function applyItem(line: DraftLine, item: Row, type: DocumentType): DraftLine {
  const purchase = isPurchase(type);
  const price = Number(purchase ? item['purchase_rate_paise'] : item['sale_rate_paise']) || 0;
  return {
    ...line,
    itemId: item['id'],
    description: item['name'],
    hsn: item['hsn'] ?? '',
    unitId: item['unit_id'] ?? null,
    ratePaise: BigInt(price),
    inclusive: !purchase && !!item['tax_inclusive'],
    gstRateBp: Number(item['gst_rate_bp'] ?? 0),
    cessBp: Number(item['cess_bp'] ?? 0),
    taxability: 'taxable',
  };
}

export interface PartyContext {
  /** The business's state code. */
  businessState: string;
}

/**
 * Apply a chosen party: name, GSTIN, place of supply, SEZ and export flags, and the due date from its
 * credit days. For a purchase the party is the supplier, so the supplier state is the party's and the
 * place of supply is the business's.
 */
export function applyParty(d: DraftDocument, party: Row | null, ctx: PartyContext): DraftDocument {
  if (!party) {
    return { ...d, partyId: null, partyName: '', partyGstin: null, partyState: null };
  }
  const state: string = party['state_code'] ?? ctx.businessState;
  const exporting = !!party['is_export'];
  const purchase = isPurchase(d.type);
  return {
    ...d,
    partyId: party['id'],
    partyName: party['name'],
    partyGstin: party['gstin'] ?? null,
    partyState: party['state_code'] ?? null,
    supplierState: purchase ? state : ctx.businessState,
    placeOfSupply: purchase ? ctx.businessState : exporting ? '96' : state,
    sez: !!party['is_sez'],
    export: !purchase && exporting,
    lut: !purchase && exporting ? d.lut : d.lut && !!party['is_sez'],
    dueDate: purchase ? d.dueDate : dueDateFor(d.date, Number(party['credit_days'] ?? 0)),
  };
}

/* ------------------------------------------------------------------ grid cells */

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export const qtyText = (micros: bigint): string => trimZeros(toDecimalString(micros, 6));
export const rateText = (bp: number): string => trimZeros(toDecimalString(BigInt(bp)));
export const paiseText = (p: bigint): string => toDecimalString(p);

export interface CellContext {
  units: ReadonlyMap<string, string>;
  discountMode: DraftDocument['discountMode'];
  built: BuiltLine | undefined;
}

/** The text a grid cell shows. */
export function cellText(l: DraftLine, col: GridColumn, c: CellContext): string {
  const blank = isBlankLine(l);
  const r = c.built?.result;
  switch (col) {
    case 'item':
      return l.description;
    case 'hsn':
      return l.hsn;
    case 'qty':
      return blank && l.qtyMicros === 1_000_000n ? '' : qtyText(l.qtyMicros);
    case 'unit':
      return l.unitId ? (c.units.get(l.unitId) ?? '') : '';
    case 'rate':
      return blank ? '' : paiseText(l.ratePaise);
    case 'incl':
      return l.inclusive ? 'Yes' : '';
    case 'discount':
      if (c.discountMode === 'none' || blank) return '';
      return l.discountValue === 0n
        ? ''
        : c.discountMode === 'percent'
          ? rateText(Number(l.discountValue))
          : paiseText(l.discountValue);
    case 'taxable':
      return r ? paiseText(r.taxablePaise) : '';
    case 'taxRate':
      return blank ? '' : rateText(r ? r.appliedRateBp : l.gstRateBp);
    case 'tax':
      return r ? paiseText(r.taxPaise) : '';
    case 'total':
      return r ? paiseText(r.totalPaise) : '';
    case 'note':
      return l.note;
  }
}

export type CellError = 'qty' | 'rate' | 'discount' | 'gst_rate' | 'hsn' | 'unit';

/**
 * Apply typed text to one cell. Returns the new line, or an error code when the text cannot be read
 * (nothing is changed then). Blank text clears optional values.
 */
export function setCell(
  l: DraftLine,
  col: GridColumn,
  text: string,
  c: Pick<CellContext, 'discountMode'> & { unitsByCode: ReadonlyMap<string, string> },
): { line: DraftLine; error?: CellError } {
  const t = text.trim();
  const fail = (error: CellError) => ({ line: l, error });
  switch (col) {
    case 'item':
      // typing a different name unlinks the stored item but keeps its numbers
      return {
        line: {
          ...l,
          description: trim(text),
          itemId: trim(text) === l.description ? l.itemId : null,
        },
      };
    case 'hsn': {
      const hsn = t.replace(/[\s.]/g, '');
      return hsn !== '' && !/^\d{4,8}$/.test(hsn) ? fail('hsn') : { line: { ...l, hsn } };
    }
    case 'qty': {
      if (t === '') return { line: { ...l, qtyMicros: 1_000_000n } };
      const q = parseQtyMicros(t);
      return q === null || q === undefined || q <= 0
        ? fail('qty')
        : { line: { ...l, qtyMicros: BigInt(q) } };
    }
    case 'unit': {
      if (t === '') return { line: { ...l, unitId: null } };
      const id = c.unitsByCode.get(t.toUpperCase());
      return id ? { line: { ...l, unitId: id } } : fail('unit');
    }
    case 'rate': {
      const p = parseAmountPaise(t);
      return p === null ? fail('rate') : { line: { ...l, ratePaise: BigInt(p ?? 0) } };
    }
    case 'incl':
      return { line: { ...l, inclusive: /^(y|yes|true|1|x|✓)$/i.test(t) } };
    case 'discount': {
      if (c.discountMode === 'none') return { line: l };
      if (t === '') return { line: { ...l, discountValue: 0n } };
      const v = c.discountMode === 'percent' ? parseRateBp(t) : parseAmountPaise(t);
      if (v === null || v === undefined) return fail('discount');
      if (c.discountMode === 'percent' && v > 10_000) return fail('discount');
      return { line: { ...l, discountValue: BigInt(v) } };
    }
    case 'taxRate': {
      const bp = parseRateBp(t);
      if (bp === null || bp === undefined || !GST_RATES_BP.includes(bp)) return fail('gst_rate');
      return { line: { ...l, gstRateBp: bp } };
    }
    case 'note':
      return { line: { ...l, note: trim(text) } };
    case 'taxable':
    case 'tax':
    case 'total':
      return { line: l };
  }
}

/** Replace one row, keeping a blank row at the end. */
export function updateLine(
  d: DraftDocument,
  key: string,
  f: (l: DraftLine) => DraftLine,
): DraftDocument {
  return withTrailingBlank({ ...d, lines: d.lines.map((l) => (l.key === key ? f(l) : l)) });
}

/** Move a row from one position to another (drag to reorder). */
export function moveLine(d: DraftDocument, from: number, to: number): DraftDocument {
  if (from === to || from < 0 || to < 0 || from >= d.lines.length || to >= d.lines.length) return d;
  const lines = [...d.lines];
  const [moved] = lines.splice(from, 1);
  lines.splice(to, 0, moved!);
  return withTrailingBlank({ ...d, lines });
}

export function removeLines(d: DraftDocument, keys: ReadonlySet<string>): DraftDocument {
  return withTrailingBlank({ ...d, lines: d.lines.filter((l) => !keys.has(l.key)) });
}

/**
 * Paste a block of text (as copied from a spreadsheet) with its top-left at `(col, row)`. Rows beyond
 * the end are added. Returns the cells that could not be read.
 */
export function pasteBlock(
  d: DraftDocument,
  columns: readonly GridColumn[],
  col: number,
  row: number,
  block: readonly (readonly string[])[],
  units: ReadonlyMap<string, string>,
): { draft: DraftDocument; rejected: { row: number; col: GridColumn; error: CellError }[] } {
  let lines = [...d.lines];
  const rejected: { row: number; col: GridColumn; error: CellError }[] = [];
  block.forEach((cells, dy) => {
    const r = row + dy;
    while (lines.length <= r) lines.push(emptyDraftLine(newLineKey()));
    cells.forEach((text, dx) => {
      const name = columns[col + dx];
      if (!name || !EDITABLE.has(name)) return;
      const out = setCell(lines[r]!, name, text, {
        discountMode: d.discountMode,
        unitsByCode: units,
      });
      if (out.error) rejected.push({ row: r, col: name, error: out.error });
      else lines[r] = out.line;
    });
  });
  lines = withTrailingBlank({ ...d, lines }).lines;
  return { draft: { ...d, lines }, rejected };
}

/**
 * Two lists of problems are the same when they say the same things, whatever array they live in. The
 * line grid redraws its canvas when this is false, so it must not be false just because a list was
 * made again (every keystroke makes a new one).
 */
export const sameIssues = (a: readonly DraftIssue[], b: readonly DraftIssue[]): boolean =>
  a === b ||
  (a.length === b.length &&
    a.every((x, i) => x.field === b[i]!.field && x.code === b[i]!.code && x.line === b[i]!.line));

/**
 * Start a purchase bill from a GSTR-2B line: the supplier (as if chosen in the party picker), the
 * supplier's own invoice number and date, and one line for the taxable value at the rate the tax implies.
 */
export function applyBillPrefill(
  d: DraftDocument,
  p: BillPrefill,
  businessState: string,
  lineKey: string,
): DraftDocument {
  const withParty = applyParty(d, p.party as unknown as Row, { businessState });
  return {
    ...withParty,
    date: p.date,
    supplierInvoiceNo: p.number,
    supplierInvoiceDate: p.date,
    lines: [
      {
        ...emptyDraftLine(lineKey),
        description: `GSTR-2B ${p.number}`,
        ratePaise: BigInt(p.taxable),
        gstRateBp: impliedRateBp(p.taxable, p.igst, p.cgst, p.sgst),
      },
    ],
  };
}
