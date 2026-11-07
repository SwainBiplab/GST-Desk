/**
 * The document editor's model and the one function that turns it into money.
 *
 * `DraftDocument` is what the editor holds (BigInt money, one entry per grid row). `buildDocument`
 * runs it through the tax engine (`computeDocument`) and returns the totals, the engine trace and
 * the rows to store. Nothing outside this file computes tax, discount, rounding or totals.
 */
import {
  computeDocument,
  type DocumentResult,
  type DocumentTotals,
  type InvoiceDiscount,
} from '../tax/document';
import type { DiscountInput, LineInput, LineResult, Taxability } from '../tax/line';
import { supplyType, type SupplyType } from '../tax/supply';
import type { TraceStep } from '../trace';
import type { DocumentType } from '../turnover';

/** How the per-line discount value is read. One mode per document; the value is per line. */
export type LineDiscountMode = 'none' | 'percent' | 'per_unit';

export interface DraftLine {
  /** Stable id for the grid row, never stored. */
  key: string;
  itemId: string | null;
  description: string;
  hsn: string;
  qtyMicros: bigint;
  unitId: string | null;
  /** Rate per unit in paise. Includes tax when `inclusive`. */
  ratePaise: bigint;
  /** Basis points when the document mode is percent, paise per unit when per_unit. */
  discountValue: bigint;
  inclusive: boolean;
  /** The item's GST rate in basis points (applied only when taxable). */
  gstRateBp: number;
  cessBp: number;
  taxability: Taxability;
  note: string;
  /** Where the goods come from or go to; null means the item's (then the business's) default godown. */
  godownId: string | null;
  /** A batch-tracked item: the batch chosen; null on a sale means first expiry, first out. */
  batchId: string | null;
  /** A serial-tracked item: one serial per unit. */
  serials: string[];
}

export interface DraftDocument {
  type: DocumentType;
  /** ISO date. */
  date: string;
  dueDate: string | null;
  partyId: string | null;
  partyName: string;
  partyGstin: string | null;
  /** The party's own state code, so the place of supply can go back to it. */
  partyState: string | null;
  /** State code of the business for sales, of the supplier for purchases. */
  supplierState: string;
  /** State code of the place of supply, or `96` for an export. */
  placeOfSupply: string;
  sez: boolean;
  export: boolean;
  /** Export or SEZ supplied under a Letter of Undertaking: no IGST charged. */
  lut: boolean;
  reverseCharge: boolean;
  /** The business is under the composition scheme. */
  composition: boolean;
  discountMode: LineDiscountMode;
  lines: DraftLine[];
  invoiceDiscount: InvoiceDiscount | null;
  roundOff: boolean;
  tcs: { rateBp: number; cumulativeBeforePaise: bigint } | null;
  tds: { rateBp: number; cumulativeBeforePaise: bigint; applicable: boolean } | null;
  currency: string;
  /** Units of rupees per unit of foreign currency, in micro-units (1.000000 = 1_000_000). */
  fxRateMicros: bigint;
  notes: string;
  terms: string;
  /** Free-form references: PO number, challan number and so on. */
  refs: Record<string, string>;
  /** Purchase bills: the supplier's own invoice. */
  supplierInvoiceNo: string;
  supplierInvoiceDate: string | null;
  itcEligible: boolean;
  /** The number series to issue from; null means the default for the type and shell. */
  seriesKey: string | null;
  /** Delivery challan: take the goods out of stock when it is issued. */
  reduceStock: boolean;
  /** Delivery challan: the goods are expected back. */
  returnable: boolean;
}

export const emptyDraftLine = (key: string): DraftLine => ({
  key,
  itemId: null,
  description: '',
  hsn: '',
  qtyMicros: 1_000_000n,
  unitId: null,
  ratePaise: 0n,
  discountValue: 0n,
  inclusive: false,
  gstRateBp: 0,
  cessBp: 0,
  taxability: 'taxable',
  note: '',
  godownId: null,
  batchId: null,
  serials: [],
});

export const emptyDraft = (
  type: DocumentType,
  date: string,
  base: { supplierState: string; composition?: boolean } = { supplierState: '' },
): DraftDocument => ({
  type,
  date,
  dueDate: null,
  partyId: null,
  partyName: '',
  partyGstin: null,
  partyState: null,
  supplierState: base.supplierState,
  placeOfSupply: base.supplierState,
  sez: false,
  export: false,
  lut: false,
  reverseCharge: false,
  composition: base.composition ?? false,
  discountMode: 'none',
  lines: [],
  invoiceDiscount: null,
  roundOff: true,
  tcs: null,
  tds: null,
  currency: 'INR',
  fxRateMicros: 1_000_000n,
  notes: '',
  terms: '',
  refs: {},
  supplierInvoiceNo: '',
  supplierInvoiceDate: null,
  itcEligible: true,
  seriesKey: null,
  reduceStock: false,
  returnable: false,
});

/** A line the editor can price: it has something to sell and a quantity. */
export const isFilledLine = (l: DraftLine): boolean =>
  (l.itemId !== null || l.description.trim() !== '') && l.qtyMicros > 0n;

/** Is anything typed on this row at all? Untouched trailing rows are dropped on save. */
export const isBlankLine = (l: DraftLine): boolean =>
  l.itemId === null && l.description.trim() === '' && l.ratePaise === 0n && l.hsn.trim() === '';

/** The engine's supply type for this draft. */
export function supplyOf(d: DraftDocument): SupplyType {
  return supplyType(d.supplierState, d.placeOfSupply, {
    ...(d.export ? { export: true } : {}),
    ...(d.sez ? { sez: true } : {}),
    ...(d.lut ? { lut: true } : {}),
  });
}

/** The coarser supply type the `documents` table stores. */
export function storedSupply(s: SupplyType): 'intra' | 'inter' | 'export' | 'sez' {
  if (s === 'intra' || s === 'inter' || s === 'export') return s;
  return s === 'deemed_export' ? 'inter' : 'sez';
}

function discountOf(mode: LineDiscountMode, value: bigint): DiscountInput {
  if (mode === 'percent') return { mode: 'percent', bp: Number(value) };
  if (mode === 'per_unit') return { mode: 'per_unit', perUnitPaise: value };
  return { mode: 'none' };
}

function lineInput(l: DraftLine, mode: LineDiscountMode): LineInput {
  return {
    qtyMicros: l.qtyMicros,
    ratePaise: l.ratePaise,
    discount: discountOf(mode, l.discountValue),
    pricing: l.inclusive ? 'inclusive' : 'exclusive',
    gstRateBp: l.gstRateBp,
    cessBp: l.cessBp,
    taxability: l.taxability,
  };
}

/** Plain-number line, shaped like a `document_lines` row. */
export interface LineRow {
  line_no: number;
  item_id: string | null;
  description: string;
  hsn: string | null;
  qty_micros: number;
  unit_id: string | null;
  rate_paise: number;
  discount_mode: 'none' | 'percent' | 'per_unit';
  discount_value: number;
  taxable_paise: number;
  cgst_bp: number;
  sgst_bp: number;
  igst_bp: number;
  utgst_bp: number;
  cess_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  utgst_paise: number;
  cess_paise: number;
  total_paise: number;
  gst_rate_bp: number;
  price_includes_tax: boolean;
  taxability: Taxability;
  note: string | null;
  godown_id: string | null;
  batch_id: string | null;
  serials_json: string[] | null;
}

/** Plain-number totals, shaped like the money columns of a `documents` row. */
export interface DocumentMoneyRow {
  total_taxable_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  total_igst_paise: number;
  total_utgst_paise: number;
  total_cess_paise: number;
  tcs_paise: number;
  tds_paise: number;
  round_off_paise: number;
  total_paise: number;
}

export interface BuiltLine {
  key: string;
  result: LineResult;
  row: LineRow;
}

export interface BuiltDocument {
  supply: SupplyType;
  totals: DocumentTotals;
  lines: BuiltLine[];
  /** Keys of the draft lines that were priced, in order (blank rows are skipped). */
  trace: TraceStep[];
  money: DocumentMoneyRow;
}

const num = (v: bigint): number => Number(v);
const half = (bp: number) => Math.round(bp / 2);

function rowOf(l: DraftLine, r: LineResult, lineNo: number, mode: LineDiscountMode): LineRow {
  const rate = r.appliedRateBp;
  const split =
    r.heads === 'igst'
      ? { cgst: 0, sgst: 0, utgst: 0, igst: rate }
      : r.heads === 'cgst_utgst'
        ? { cgst: half(rate), sgst: 0, utgst: half(rate), igst: 0 }
        : r.heads === 'cgst_sgst'
          ? { cgst: half(rate), sgst: half(rate), utgst: 0, igst: 0 }
          : { cgst: 0, sgst: 0, utgst: 0, igst: 0 };
  return {
    line_no: lineNo,
    item_id: l.itemId,
    description: l.description.trim(),
    hsn: l.hsn.trim() || null,
    qty_micros: num(l.qtyMicros),
    unit_id: l.unitId,
    rate_paise: num(l.ratePaise),
    discount_mode: mode,
    discount_value: mode === 'none' ? 0 : num(l.discountValue),
    taxable_paise: num(r.taxablePaise),
    cgst_bp: split.cgst,
    sgst_bp: split.sgst,
    igst_bp: split.igst,
    utgst_bp: split.utgst,
    cess_bp: r.cessPaise > 0n ? l.cessBp : 0,
    cgst_paise: num(r.cgstPaise),
    sgst_paise: num(r.sgstPaise),
    igst_paise: num(r.igstPaise),
    utgst_paise: num(r.utgstPaise),
    cess_paise: num(r.cessPaise),
    total_paise: num(r.totalPaise),
    gst_rate_bp: l.gstRateBp,
    price_includes_tax: l.inclusive,
    taxability: l.taxability,
    note: l.note.trim() || null,
    godown_id: l.godownId,
    batch_id: l.batchId,
    serials_json: l.serials.length > 0 ? [...l.serials] : null,
  };
}

/**
 * Price a draft. Blank rows are ignored; every other row goes through the engine. This is the only
 * place the editor, the preview, the trace panel and the saved rows get their numbers from.
 */
export function buildDocument(d: DraftDocument): BuiltDocument {
  const kept = d.lines.filter((l) => !isBlankLine(l));
  const supply = supplyOf(d);
  const engine = computeDocument(
    kept.map((l) => lineInput(l, d.discountMode)),
    {
      supply,
      supplierState: d.supplierState,
      placeOfSupply: d.placeOfSupply,
      date: d.date,
      roundOff: d.roundOff ? 'nearest_rupee' : 'none',
      ...(d.lut ? { lut: true } : {}),
      ...(d.reverseCharge ? { reverseCharge: true } : {}),
      ...(d.composition ? { composition: true } : {}),
      ...(d.invoiceDiscount ? { invoiceDiscount: d.invoiceDiscount } : {}),
      ...(d.tcs ? { tcs: d.tcs } : {}),
      ...(d.tds
        ? {
            tds: {
              rateBp: d.tds.rateBp,
              cumulativeBeforePaise: d.tds.cumulativeBeforePaise,
              applicable: d.tds.applicable,
            },
          }
        : {}),
    },
  );
  const result: DocumentResult = engine.result;
  const t = result.totals;
  return {
    supply,
    totals: t,
    trace: engine.trace,
    lines: kept.map((l, i) => ({
      key: l.key,
      result: result.lines[i]!,
      row: rowOf(l, result.lines[i]!, i + 1, d.discountMode),
    })),
    money: {
      total_taxable_paise: num(t.taxablePaise),
      total_cgst_paise: num(t.cgstPaise),
      total_sgst_paise: num(t.sgstPaise),
      total_igst_paise: num(t.igstPaise),
      total_utgst_paise: num(t.utgstPaise),
      total_cess_paise: num(t.cessPaise),
      tcs_paise: num(t.tcsPaise),
      tds_paise: num(t.tdsPaise),
      round_off_paise: num(t.roundOffPaise),
      total_paise: num(t.totalPaise),
    },
  };
}
