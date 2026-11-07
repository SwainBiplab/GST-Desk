/**
 * Saving and restoring a draft. `draftToRows` gives the `documents` and `document_lines` rows (money
 * from the engine, editor-only settings in `metadata_json`); `draftFromRows` rebuilds the editor
 * state from them, so a reopened draft prices to exactly what was saved.
 */
import type { InvoiceDiscount } from '../tax/document';
import type { Taxability } from '../tax/line';
import type { DocumentType } from '../turnover';

import {
  buildDocument,
  emptyDraft,
  storedSupply,
  type BuiltDocument,
  type DraftDocument,
  type DraftLine,
  type DocumentMoneyRow,
  type LineDiscountMode,
  type LineRow,
} from './build';
import { sanitiseRichText } from './richtext';

type Row = Record<string, unknown>;

/** Editor settings that have no column of their own. Money is stored as strings (no BigInt in JSON). */
export interface DraftMeta {
  v: 1;
  discountMode: LineDiscountMode;
  invoiceDiscount: { mode: 'percent' | 'amount'; value: string } | null;
  roundOff: boolean;
  tcs: { rateBp: number; cumulativeBeforePaise: string } | null;
  tds: { rateBp: number; cumulativeBeforePaise: string; applicable: boolean } | null;
  sez: boolean;
  export: boolean;
  lut: boolean;
  composition: boolean;
  supplierState: string;
  partyGstin: string | null;
  partyState: string | null;
  refs: Record<string, string>;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string | null;
  itcEligible: boolean;
  seriesKey?: string | null;
  reduceStock?: boolean;
  returnable?: boolean;
}

export function metaOf(d: DraftDocument): DraftMeta {
  return {
    v: 1,
    discountMode: d.discountMode,
    invoiceDiscount: d.invoiceDiscount
      ? {
          mode: d.invoiceDiscount.mode,
          value: String(
            d.invoiceDiscount.mode === 'percent' ? d.invoiceDiscount.bp : d.invoiceDiscount.paise,
          ),
        }
      : null,
    roundOff: d.roundOff,
    tcs: d.tcs
      ? { rateBp: d.tcs.rateBp, cumulativeBeforePaise: String(d.tcs.cumulativeBeforePaise) }
      : null,
    tds: d.tds
      ? {
          rateBp: d.tds.rateBp,
          cumulativeBeforePaise: String(d.tds.cumulativeBeforePaise),
          applicable: d.tds.applicable,
        }
      : null,
    sez: d.sez,
    export: d.export,
    lut: d.lut,
    composition: d.composition,
    supplierState: d.supplierState,
    partyGstin: d.partyGstin,
    partyState: d.partyState,
    refs: d.refs,
    supplierInvoiceNo: d.supplierInvoiceNo,
    supplierInvoiceDate: d.supplierInvoiceDate,
    itcEligible: d.itcEligible,
    seriesKey: d.seriesKey,
    reduceStock: d.reduceStock,
    returnable: d.returnable,
  };
}

export interface DocumentRowValues extends DocumentMoneyRow {
  type: DocumentType;
  date: string;
  due_date: string | null;
  party_id: string | null;
  party_name: string | null;
  place_of_supply_state: string;
  supply_type: 'intra' | 'inter' | 'export' | 'sez';
  reverse_charge: boolean;
  currency: string;
  fx_rate_micros: number;
  notes: string | null;
  terms: string | null;
  metadata_json: DraftMeta;
}

/** Rows to store for a draft. Notes and terms are sanitised here, so nothing unsafe is ever saved. */
export function draftToRows(d: DraftDocument): {
  doc: DocumentRowValues;
  lines: LineRow[];
  built: BuiltDocument;
} {
  const built = buildDocument(d);
  const notes = sanitiseRichText(d.notes);
  const terms = sanitiseRichText(d.terms);
  return {
    built,
    lines: built.lines.map((l) => l.row),
    doc: {
      ...built.money,
      type: d.type,
      date: d.date,
      due_date: d.dueDate,
      party_id: d.partyId,
      party_name: d.partyName.trim() || null,
      place_of_supply_state: d.placeOfSupply,
      supply_type: storedSupply(built.supply),
      reverse_charge: d.reverseCharge,
      currency: d.currency,
      fx_rate_micros: Number(d.fxRateMicros),
      notes: notes || null,
      terms: terms || null,
      metadata_json: metaOf(d),
    },
  };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const big = (v: unknown, fallback = 0n): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return fallback;
};

/** Rebuild the editor's draft from stored rows. `newKey` makes the grid row keys. */
export function draftFromRows(
  doc: Row,
  lines: readonly Row[],
  newKey: () => string,
): DraftDocument {
  const meta = (doc['metadata_json'] ?? {}) as Partial<DraftMeta>;
  const base = emptyDraft(doc['type'] as DocumentType, str(doc['date']), {
    supplierState: meta.supplierState ?? str(doc['place_of_supply_state']),
    composition: meta.composition ?? false,
  });
  const invoiceDiscount: InvoiceDiscount | null = meta.invoiceDiscount
    ? meta.invoiceDiscount.mode === 'percent'
      ? { mode: 'percent', bp: Number(meta.invoiceDiscount.value) }
      : { mode: 'amount', paise: big(meta.invoiceDiscount.value) }
    : null;
  const mode = (meta.discountMode ??
    (lines[0]?.['discount_mode'] === 'percent' || lines[0]?.['discount_mode'] === 'per_unit'
      ? lines[0]['discount_mode']
      : 'none')) as LineDiscountMode;

  return {
    ...base,
    dueDate: (doc['due_date'] as string | null) ?? null,
    partyId: (doc['party_id'] as string | null) ?? null,
    partyName: str(doc['party_name']),
    partyGstin: meta.partyGstin ?? null,
    partyState: meta.partyState ?? null,
    placeOfSupply: str(doc['place_of_supply_state']),
    sez: meta.sez ?? false,
    export: meta.export ?? false,
    lut: meta.lut ?? false,
    reverseCharge: !!doc['reverse_charge'],
    discountMode: mode,
    invoiceDiscount,
    roundOff: meta.roundOff ?? true,
    tcs: meta.tcs
      ? { rateBp: meta.tcs.rateBp, cumulativeBeforePaise: big(meta.tcs.cumulativeBeforePaise) }
      : null,
    tds: meta.tds
      ? {
          rateBp: meta.tds.rateBp,
          cumulativeBeforePaise: big(meta.tds.cumulativeBeforePaise),
          applicable: meta.tds.applicable,
        }
      : null,
    currency: str(doc['currency'], 'INR'),
    fxRateMicros: big(doc['fx_rate_micros'], 1_000_000n),
    notes: str(doc['notes']),
    terms: str(doc['terms']),
    refs: meta.refs ?? {},
    supplierInvoiceNo: meta.supplierInvoiceNo ?? '',
    supplierInvoiceDate: meta.supplierInvoiceDate ?? null,
    itcEligible: meta.itcEligible ?? true,
    seriesKey: meta.seriesKey ?? null,
    reduceStock: meta.reduceStock ?? false,
    returnable: meta.returnable ?? false,
    lines: [...lines]
      .sort((a, b) => Number(a['line_no']) - Number(b['line_no']))
      .map((l): DraftLine => ({
        key: newKey(),
        itemId: (l['item_id'] as string | null) ?? null,
        description: str(l['description']),
        hsn: str(l['hsn']),
        qtyMicros: big(l['qty_micros'], 1_000_000n),
        unitId: (l['unit_id'] as string | null) ?? null,
        ratePaise: big(l['rate_paise']),
        discountValue: big(l['discount_value']),
        inclusive: !!l['price_includes_tax'],
        gstRateBp: Number(l['gst_rate_bp'] ?? 0),
        cessBp: Number(l['cess_bp'] ?? 0),
        taxability: (str(l['taxability'], 'taxable') as Taxability) || 'taxable',
        note: str(l['note']),
        godownId: (l['godown_id'] as string | null) ?? null,
        batchId: (l['batch_id'] as string | null) ?? null,
        serials: Array.isArray(l['serials_json'])
          ? (l['serials_json'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
      })),
  };
}
