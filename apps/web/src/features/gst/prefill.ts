/**
 * "Create purchase bill" from a GSTR-2B line: the line is handed to the editor through the browser's
 * session storage for a couple of minutes, and the editor starts a purchase bill with the supplier, the
 * supplier's invoice number and date, and one line for the taxable value at the rate the tax implies.
 * The person checks it, adds the HSN and issues it like any other bill.
 */
import { GST_RATES_BP } from '@gst/domain';

const KEY = 'gst.prefill.bill';
const MAX_AGE_MS = 2 * 60_000;

export interface BillPrefill {
  /** The supplier as a party row (created first when the business did not have them). */
  party: { id: string; name: string; gstin: string; state_code: string };
  number: string;
  /** The supplier's invoice date, YYYY-MM-DD. */
  date: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  at: number;
}

export function stashPrefill(p: Omit<BillPrefill, 'at'>, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...p, at: now }));
  } catch {
    // storage blocked: the bill simply opens blank
  }
}

/** Look at the waiting prefill without removing it (safe to call twice, as React sometimes does). */
export function peekPrefill(now = Date.now()): BillPrefill | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as BillPrefill;
    return typeof p.at === 'number' && now - p.at <= MAX_AGE_MS && p.party?.id ? p : null;
  } catch {
    return null;
  }
}

export function clearPrefill(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * The GST rate in basis points that the tax shown implies for the taxable value, snapped to the
 * nearest standard rate when it is within a quarter of a percent (a rounding difference), by integer
 * arithmetic.
 */
export function impliedRateBp(taxable: number, igst: number, cgst: number, sgst: number): number {
  if (taxable <= 0) return 0;
  const tax = BigInt(igst + cgst + sgst);
  const t = BigInt(taxable);
  const raw = Number((tax * 10_000n + t / 2n) / t);
  let best = raw;
  let gap = 26;
  for (const r of GST_RATES_BP) {
    const g = Math.abs(r - raw);
    if (g < gap) {
      gap = g;
      best = r;
    }
  }
  return best;
}
