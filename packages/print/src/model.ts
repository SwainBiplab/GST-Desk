/**
 * The print model: everything a printed document says, as plain strings and numbers, built from the
 * same draft and engine result the editor shows. Layout and renderers never calculate; they place what
 * is here. That is why a printed total always equals the screen total.
 */
import {
  STATES,
  declarationFor,
  toDecimalString,
  type BuiltDocument,
  type DocumentType,
  type DraftDocument,
} from '@gst/domain';
import type { PrintLanguage } from '@gst/i18n';

import type { SupplyKind } from './spec';

export interface PrintBusiness {
  name: string;
  gstin: string | null;
  pan: string | null;
  /** Address as printed lines. */
  address: string[];
  phone: string | null;
  email: string | null;
  scheme: 'regular' | 'composition';
  /** A logo as a PNG or JPEG data URL, with its natural size. */
  logo: { dataUrl: string; width: number; height: number } | null;
}

export interface PrintParty {
  name: string;
  gstin: string | null;
  address: string[];
  stateName: string | null;
  phone: string | null;
  /** The language this party's documents are printed in; absent means the template's language. */
  language?: PrintLanguage;
}

export interface PrintAccount {
  kind: 'bank' | 'upi' | 'cash' | 'wallet';
  name: string;
  holder: string | null;
  accountNo: string | null;
  ifsc: string | null;
  upiId: string | null;
}

export interface PrintInput {
  draft: DraftDocument;
  built: BuiltDocument;
  number: string | null;
  status: 'draft' | 'issued' | 'cancelled';
  revision?: number;
  business: PrintBusiness;
  party: PrintParty | null;
  shipTo?: string[] | null;
  accounts: readonly PrintAccount[];
  units: ReadonlyMap<string, string>;
  einvoice?: {
    irn: string;
    ackNo: string | null;
    ackDate: string | null;
    signedQr: string | null;
  } | null;
  eway?: string | null;
}

export interface PrintLine {
  no: string;
  description: string;
  note: string | null;
  hsn: string;
  qty: string;
  unit: string;
  rate: string;
  discount: string;
  taxable: string;
  taxRate: string;
  cgstRate: string;
  sgstRate: string;
  utgstRate: string;
  igstRate: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  /** All tax charged on the line. */
  tax: string;
  amount: string;
}

export interface TaxSummaryRow {
  hsn: string;
  rate: string;
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  tax: string;
}

export interface PrintTotals {
  taxable: string;
  discount: string | null;
  cgst: string | null;
  sgst: string | null;
  utgst: string | null;
  igst: string | null;
  cess: string | null;
  tax: string | null;
  tcs: string | null;
  roundOff: string | null;
  total: string;
  totalPaise: bigint;
}

export interface PrintModel {
  type: DocumentType;
  number: string | null;
  status: 'draft' | 'issued' | 'cancelled';
  revision: number;
  date: string;
  dueDate: string | null;
  supply: SupplyKind;
  reverseCharge: boolean;
  business: PrintBusiness;
  party: PrintParty | null;
  shipTo: string[] | null;
  placeOfSupply: string;
  refs: { key: 'po' | 'challan' | 'supplierInvoice'; value: string }[];
  lines: PrintLine[];
  /** Which tax heads the document actually charges, so split tax columns show only those. */
  heads: { cgst: boolean; sgst: boolean; utgst: boolean; igst: boolean; cess: boolean };
  taxSummary: TaxSummaryRow[];
  totals: PrintTotals;
  foreign: { currency: string; amount: string } | null;
  accounts: PrintAccount[];
  upi: { id: string; name: string; payload: string } | null;
  terms: string[];
  notes: string[];
  /** The Rule 46A wording on a composition business's bill of supply. */
  declaration: string | null;
  einvoice: PrintInput['einvoice'] | null;
  eway: string | null;
  /** What the invoice QR carries: number, date, total and the supplier's GSTIN. */
  qr: string | null;
}

/* ------------------------------------------------------------------ formatting */

/** 1234567.5 paise-exact as "12,345.67": Indian grouping (last three digits, then pairs). */
export function formatInr(paise: bigint, opts: { symbol?: boolean } = {}): string {
  const negative = paise < 0n;
  const [rupees, ps] = toDecimalString(negative ? -paise : paise).split('.') as [string, string];
  let grouped = rupees;
  if (rupees.length > 3) {
    const head = rupees.slice(0, -3);
    const tail = rupees.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }
  return `${negative ? '-' : ''}${opts.symbol ? '₹' : ''}${grouped}.${ps}`;
}

const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
/** Quantity in micro-units as a short decimal: 2.5, 12, 0.125. */
export const formatQty = (micros: bigint): string => trimZeros(toDecimalString(micros, 6));
/** A rate in basis points as a percentage: 18%, 2.5%. */
export const formatRate = (bp: number): string => `${trimZeros(toDecimalString(BigInt(bp)))}%`;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** The sanitised rich text of notes and terms as plain lines (list items get a bullet). */
export function richToLines(html: string): string[] {
  const text = html
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const rawKind = (s: BuiltDocument['supply']): SupplyKind =>
  s === 'intra' ? 'intra' : s === 'inter' ? 'inter' : 'export';

/** UPI deep link used for the payment QR: payee, name, the amount due and a note with the number. */
export function upiPayload(id: string, name: string, totalPaise: bigint, note: string): string {
  const amount = toDecimalString(totalPaise);
  return `upi://pay?pa=${encodeURIComponent(id)}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

/* ------------------------------------------------------------------ build */

export function buildPrintModel(i: PrintInput): PrintModel {
  const { draft: d, built: b } = i;
  const composition = i.business.scheme === 'composition' || d.composition;
  // a bill of supply charges no tax; if one somehow carries tax it is shown, never hidden
  const taxless = composition || (d.type === 'bill_of_supply' && b.totals.taxPaise === 0n);
  const supply: SupplyKind = taxless ? 'none' : rawKind(b.supply);

  const lines: PrintLine[] = b.lines.map((l, n) => {
    const src = d.lines.find((x) => x.key === l.key)!;
    const r = l.result;
    const row = l.row as unknown as Record<string, number>;
    const discount = r.discountPaise > 0n ? formatInr(r.discountPaise) : '';
    return {
      no: String(n + 1),
      description: src.description,
      note: src.note.trim() || null,
      hsn: src.hsn,
      qty: formatQty(src.qtyMicros),
      unit: src.unitId ? (i.units.get(src.unitId) ?? '') : '',
      rate: formatInr(src.ratePaise),
      discount,
      taxable: formatInr(r.taxablePaise),
      taxRate: formatRate(r.appliedRateBp),
      cgstRate: formatRate(row['cgst_bp'] ?? 0),
      sgstRate: formatRate(row['sgst_bp'] ?? 0),
      utgstRate: formatRate(row['utgst_bp'] ?? 0),
      igstRate: formatRate(row['igst_bp'] ?? 0),
      cgst: formatInr(r.cgstPaise),
      sgst: formatInr(r.sgstPaise),
      utgst: formatInr(r.utgstPaise),
      igst: formatInr(r.igstPaise),
      cess: formatInr(r.cessPaise),
      tax: formatInr(r.taxPaise),
      amount: formatInr(r.totalPaise),
    };
  });

  const t = b.totals;
  const heads = {
    cgst: t.cgstPaise > 0n,
    sgst: t.sgstPaise > 0n,
    utgst: t.utgstPaise > 0n,
    igst: t.igstPaise > 0n,
    cess: t.cessPaise > 0n,
  };
  // a document that charges tax still shows its heads when every line is exempt, so use the supply
  if (!taxless && !(heads.cgst || heads.sgst || heads.utgst || heads.igst)) {
    if (supply === 'intra') {
      heads.cgst = true;
      heads.sgst = true;
    } else if (supply === 'inter') heads.igst = true;
  }

  // the tax summary: one row per HSN and rate (what a return needs), in order of appearance
  const groups = new Map<string, TaxSummaryRow & { _t: bigint[] }>();
  b.lines.forEach((l, n) => {
    const src = d.lines.find((x) => x.key === l.key)!;
    const key = `${src.hsn}|${l.result.appliedRateBp}`;
    const g =
      groups.get(key) ??
      ({
        hsn: src.hsn,
        rate: formatRate(l.result.appliedRateBp),
        taxable: '',
        cgst: '',
        sgst: '',
        utgst: '',
        igst: '',
        cess: '',
        tax: '',
        _t: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
      } as TaxSummaryRow & { _t: bigint[] });
    const r = l.result;
    const add = [
      r.taxablePaise,
      r.cgstPaise,
      r.sgstPaise,
      r.utgstPaise,
      r.igstPaise,
      r.cessPaise,
      r.taxPaise,
    ];
    add.forEach((v, k) => (g._t[k] = g._t[k]! + v));
    groups.set(key, g);
    void n;
  });
  const taxSummary: TaxSummaryRow[] = [...groups.values()].map((g) => ({
    hsn: g.hsn,
    rate: g.rate,
    taxable: formatInr(g._t[0]!),
    cgst: formatInr(g._t[1]!),
    sgst: formatInr(g._t[2]!),
    utgst: formatInr(g._t[3]!),
    igst: formatInr(g._t[4]!),
    cess: formatInr(g._t[5]!),
    tax: formatInr(g._t[6]!),
  }));

  const nz = (v: bigint): string | null => (v === 0n ? null : formatInr(v));
  const totals: PrintTotals = {
    taxable: formatInr(t.taxablePaise),
    discount: nz(t.discountPaise + t.invoiceDiscountPaise),
    cgst: heads.cgst ? formatInr(t.cgstPaise) : null,
    sgst: heads.sgst ? formatInr(t.sgstPaise) : null,
    utgst: heads.utgst ? formatInr(t.utgstPaise) : null,
    igst: heads.igst ? formatInr(t.igstPaise) : null,
    cess: heads.cess ? formatInr(t.cessPaise) : null,
    tax: taxless ? null : formatInr(t.taxPaise),
    tcs: nz(t.tcsPaise),
    roundOff: nz(t.roundOffPaise),
    total: formatInr(t.totalPaise, { symbol: true }),
    totalPaise: t.totalPaise,
  };

  const foreign =
    d.currency !== 'INR' && d.fxRateMicros > 0n
      ? {
          currency: d.currency,
          amount: toDecimalString(
            (t.totalPaise * 1_000_000n + d.fxRateMicros / 2n) / d.fxRateMicros,
          ),
        }
      : null;

  const upiAccount = i.accounts.find((a) => a.kind === 'upi' && a.upiId);
  const upi = upiAccount
    ? {
        id: upiAccount.upiId!,
        name: i.business.name,
        payload: upiPayload(upiAccount.upiId!, i.business.name, t.totalPaise, i.number ?? 'draft'),
      }
    : null;

  const refs: PrintModel['refs'] = [];
  if (d.refs['po']) refs.push({ key: 'po', value: d.refs['po'] });
  if (d.refs['challan']) refs.push({ key: 'challan', value: d.refs['challan'] });
  if (d.supplierInvoiceNo) refs.push({ key: 'supplierInvoice', value: d.supplierInvoiceNo });

  const stateName = STATES[d.placeOfSupply];
  const placeOfSupply = d.export
    ? 'Outside India (96)'
    : stateName
      ? `${stateName} (${d.placeOfSupply})`
      : '';

  const gstin = i.business.gstin;
  return {
    type: d.type,
    number: i.number,
    status: i.status,
    revision: i.revision ?? 1,
    date: d.date,
    dueDate: d.dueDate,
    supply,
    reverseCharge: d.reverseCharge,
    business: i.business,
    party: i.party,
    shipTo: i.shipTo && i.shipTo.length > 0 ? [...i.shipTo] : null,
    placeOfSupply,
    refs,
    lines,
    heads,
    taxSummary,
    totals,
    foreign,
    accounts: i.accounts
      .filter((a) => a.kind === 'bank' || a.kind === 'upi')
      .map((a) => ({ ...a })),
    upi,
    terms: richToLines(d.terms),
    notes: richToLines(d.notes),
    declaration: declarationFor(d.type, composition ? 'composition' : 'regular'),
    einvoice: i.einvoice ?? null,
    eway: i.eway ?? null,
    qr:
      i.number && gstin ? `${gstin}|${i.number}|${d.date}|${toDecimalString(t.totalPaise)}` : null,
  };
}
