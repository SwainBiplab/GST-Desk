/**
 * The print model of an issued or cancelled document, built from what was stored when it was issued.
 * Nothing is recalculated, so the printed amounts are exactly the amounts on record, even if a tax rule
 * or a rate changed since. (The editor's live preview uses `buildPrintModel`, which prices the draft.)
 */
import { STATES, declarationFor, toDecimalString, type DocumentType } from '@gst/domain';

import {
  formatInr,
  formatQty,
  formatRate,
  richToLines,
  upiPayload,
  type PrintAccount,
  type PrintBusiness,
  type PrintLine,
  type PrintModel,
  type PrintParty,
  type PrintTotals,
  type TaxSummaryRow,
} from './model';
import type { SupplyKind } from './spec';

type Stored = Record<string, unknown>;

export interface StoredPrintInput {
  /** The document row as stored. */
  document: Stored;
  /** Its lines, as stored, in order. */
  lines: readonly Stored[];
  business: PrintBusiness;
  party: PrintParty | null;
  shipTo?: string[] | null;
  accounts: readonly PrintAccount[];
  /** A gateway payment link for what is owed (prompt 45). */
  payLink?: string | null;
  units: ReadonlyMap<string, string>;
}

const big = (v: unknown): bigint => BigInt(Math.trunc(Number(v ?? 0)));
const num = (v: unknown): number => Number(v ?? 0);

const rateOf = (l: Stored): number =>
  num(l['cgst_bp']) + num(l['sgst_bp']) + num(l['utgst_bp']) + num(l['igst_bp']);

export function buildStoredPrintModel(i: StoredPrintInput): PrintModel {
  const d = i.document;
  const type = d['type'] as DocumentType;
  const meta = (d['metadata_json'] ?? {}) as {
    composition?: boolean;
    refs?: Record<string, string>;
    supplierInvoiceNo?: string;
    export?: boolean;
  };
  const cg = big(d['total_cgst_paise']);
  const sg = big(d['total_sgst_paise']);
  const ut = big(d['total_utgst_paise']);
  const ig = big(d['total_igst_paise']);
  const ce = big(d['total_cess_paise']);
  const totalTax = cg + sg + ut + ig + ce;
  const composition = i.business.scheme === 'composition' || !!meta.composition;
  // a bill of supply charges no tax; if one somehow carries tax it is shown, never hidden
  const taxless = composition || (type === 'bill_of_supply' && totalTax === 0n);
  const kind = String(d['supply_type'] ?? 'intra');
  const supply: SupplyKind = taxless
    ? 'none'
    : kind === 'inter'
      ? 'inter'
      : kind === 'export' || kind === 'sez'
        ? 'export'
        : 'intra';

  let discountTotal = 0n;
  const lines: PrintLine[] = i.lines.map((l, n) => {
    const qty = big(l['qty_micros']);
    const rate = big(l['rate_paise']);
    const taxable = big(l['taxable_paise']);
    // what the discount took off, when it can be told (a price that includes tax cannot)
    const gross = l['price_includes_tax'] ? 0n : (qty * rate + 500_000n) / 1_000_000n;
    const discount = gross > taxable ? gross - taxable : 0n;
    discountTotal += discount;
    const cgst = big(l['cgst_paise']);
    const sgst = big(l['sgst_paise']);
    const utgst = big(l['utgst_paise']);
    const igst = big(l['igst_paise']);
    const cess = big(l['cess_paise']);
    return {
      no: String(n + 1),
      description: String(l['description'] ?? ''),
      note: l['note'] ? String(l['note']) : null,
      hsn: String(l['hsn'] ?? ''),
      qty: formatQty(qty),
      unit: l['unit_id'] ? (i.units.get(String(l['unit_id'])) ?? '') : '',
      rate: formatInr(rate),
      discount: discount > 0n ? formatInr(discount) : '',
      taxable: formatInr(taxable),
      taxRate: formatRate(rateOf(l)),
      cgstRate: formatRate(num(l['cgst_bp'])),
      sgstRate: formatRate(num(l['sgst_bp'])),
      utgstRate: formatRate(num(l['utgst_bp'])),
      igstRate: formatRate(num(l['igst_bp'])),
      cgst: formatInr(cgst),
      sgst: formatInr(sgst),
      utgst: formatInr(utgst),
      igst: formatInr(igst),
      cess: formatInr(cess),
      tax: formatInr(cgst + sgst + utgst + igst + cess),
      amount: formatInr(big(l['total_paise'])),
    };
  });

  const heads = { cgst: cg > 0n, sgst: sg > 0n, utgst: ut > 0n, igst: ig > 0n, cess: ce > 0n };
  if (!taxless && !(heads.cgst || heads.sgst || heads.utgst || heads.igst)) {
    if (supply === 'intra') {
      heads.cgst = true;
      heads.sgst = true;
    } else if (supply === 'inter') heads.igst = true;
  }

  // the tax summary: one row per HSN and rate, from the stored line amounts
  const sums = new Map<string, bigint[]>();
  const names = new Map<string, { hsn: string; rate: string }>();
  for (const l of i.lines) {
    const key = `${String(l['hsn'] ?? '')}|${rateOf(l)}`;
    names.set(key, { hsn: String(l['hsn'] ?? ''), rate: formatRate(rateOf(l)) });
    const g = sums.get(key) ?? [0n, 0n, 0n, 0n, 0n, 0n, 0n];
    const parts = [
      big(l['taxable_paise']),
      big(l['cgst_paise']),
      big(l['sgst_paise']),
      big(l['utgst_paise']),
      big(l['igst_paise']),
      big(l['cess_paise']),
    ];
    parts.forEach((v, k) => (g[k] = g[k]! + v));
    g[6] = g[6]! + parts[1]! + parts[2]! + parts[3]! + parts[4]! + parts[5]!;
    sums.set(key, g);
  }
  const taxSummary: TaxSummaryRow[] = [...sums.entries()].map(([key, g]) => ({
    ...names.get(key)!,
    taxable: formatInr(g[0]!),
    cgst: formatInr(g[1]!),
    sgst: formatInr(g[2]!),
    utgst: formatInr(g[3]!),
    igst: formatInr(g[4]!),
    cess: formatInr(g[5]!),
    tax: formatInr(g[6]!),
  }));

  const total = big(d['total_paise']);
  const nz = (v: bigint): string | null => (v === 0n ? null : formatInr(v));
  const totals: PrintTotals = {
    taxable: formatInr(big(d['total_taxable_paise'])),
    discount: nz(discountTotal),
    cgst: heads.cgst ? formatInr(cg) : null,
    sgst: heads.sgst ? formatInr(sg) : null,
    utgst: heads.utgst ? formatInr(ut) : null,
    igst: heads.igst ? formatInr(ig) : null,
    cess: heads.cess ? formatInr(ce) : null,
    tax: taxless ? null : formatInr(totalTax),
    tcs: nz(big(d['tcs_paise'])),
    roundOff: nz(big(d['round_off_paise'])),
    total: formatInr(total, { symbol: true }),
    totalPaise: total,
  };

  const currency = String(d['currency'] ?? 'INR');
  const fx = big(d['fx_rate_micros'] ?? 1_000_000);
  const foreign =
    currency !== 'INR' && fx > 0n
      ? { currency, amount: toDecimalString((total * 1_000_000n + fx / 2n) / fx) }
      : null;

  const number = (d['number'] as string | null) ?? null;
  const upiAccount = i.accounts.find((a) => a.kind === 'upi' && a.upiId);
  const refs: PrintModel['refs'] = [];
  if (meta.refs?.['po']) refs.push({ key: 'po', value: meta.refs['po'] });
  if (meta.refs?.['challan']) refs.push({ key: 'challan', value: meta.refs['challan'] });
  if (meta.supplierInvoiceNo) refs.push({ key: 'supplierInvoice', value: meta.supplierInvoiceNo });

  const pos = String(d['place_of_supply_state'] ?? '');
  const placeOfSupply =
    meta.export || pos === '96'
      ? 'Outside India (96)'
      : STATES[pos]
        ? `${STATES[pos]} (${pos})`
        : '';
  const gstin = i.business.gstin;
  return {
    type,
    number,
    status: d['status'] as PrintModel['status'],
    revision: Number(d['revision'] ?? 1),
    date: String(d['date']),
    dueDate: (d['due_date'] as string | null) ?? null,
    supply,
    reverseCharge: !!d['reverse_charge'],
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
    payLink: i.payLink ?? null,
    upi: upiAccount
      ? {
          id: upiAccount.upiId!,
          name: i.business.name,
          payload: upiPayload(upiAccount.upiId!, i.business.name, total, number ?? 'draft'),
        }
      : null,
    terms: richToLines(String(d['terms'] ?? '')),
    notes: richToLines(String(d['notes'] ?? '')),
    declaration: declarationFor(type, composition ? 'composition' : 'regular'),
    einvoice: d['irn']
      ? {
          irn: String(d['irn']),
          ackNo: (d['irn_ack_no'] as string | null) ?? null,
          ackDate: (d['irn_ack_date'] as string | null) ?? null,
          signedQr: (d['irn_signed_qr'] as string | null) ?? null,
        }
      : null,
    eway: (d['eway_bill_no'] as string | null) ?? null,
    qr:
      number && gstin ? `${gstin}|${number}|${String(d['date'])}|${toDecimalString(total)}` : null,
  };
}
