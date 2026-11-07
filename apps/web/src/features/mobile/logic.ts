/**
 * The phone layout's rules as pure functions (prompt 43), so they are tested without a screen and the
 * web, the phone app and the tests agree: which tab a page belongs to, the quantity stepper, swipe
 * thresholds, pull to refresh, recent parties and favourite items, and the UPI payment link.
 */
import type { Row } from '@gst/db';
import { toDecimalString } from '@gst/domain';

export const TABS = ['home', 'bill', 'parties', 'inbox', 'more'] as const;
export type Tab = (typeof TABS)[number];

/** The page each tab opens (the shop shell's pages, in the phone layout). */
export const TAB_PAGE: Record<Tab, string> = {
  home: 'dashboard',
  bill: 'sell',
  parties: 'parties',
  inbox: 'inbox',
  more: 'settings',
};

/** Which tab lights up for a page: the pages "More" lists belong to More. */
export function tabFor(page: string | null): Tab {
  switch (page) {
    case 'dashboard':
      return 'home';
    case 'sell':
      return 'bill';
    case 'parties':
      return 'parties';
    case 'inbox':
      return 'inbox';
    default:
      return 'more';
  }
}

/** The pages the More tab lists, in order. Reports and GST need their permission; the layout filters. */
export const MORE_PAGES = ['documents', 'items', 'payments', 'reports', 'gst', 'settings'] as const;

const MICRO = 1_000_000n;

/** The quantity stepper: whole steps from a whole number, else to the next whole number; never below one. */
export function stepQty(qtyMicros: bigint, dir: 1 | -1): bigint {
  const whole = qtyMicros % MICRO === 0n;
  let next: bigint;
  if (whole) next = qtyMicros + BigInt(dir) * MICRO;
  else next = dir > 0 ? (qtyMicros / MICRO + 1n) * MICRO : (qtyMicros / MICRO) * MICRO;
  return next < MICRO ? MICRO : next;
}

export const qtyLabel = (qtyMicros: bigint): string =>
  toDecimalString(qtyMicros, 6).replace(/\.?0+$/, '');

export const SWIPE_OPEN_PX = 72;
export const SWIPE_COMMIT_PX = 160;

/**
 * A row swiped sideways: under the first threshold it springs back, past it the action buttons stay
 * open, past the second the leading action runs at once (as mail apps do).
 */
export function swipeOutcome(dx: number): 'closed' | 'open' | 'commit' {
  const d = Math.abs(dx);
  if (d < SWIPE_OPEN_PX) return 'closed';
  if (d < SWIPE_COMMIT_PX) return 'open';
  return 'commit';
}

/** A pull down from the top: the list refreshes once the pull passes this, with resistance after it. */
export const PULL_TRIGGER_PX = 64;
export function pullOffset(dy: number): number {
  if (dy <= 0) return 0;
  return dy <= PULL_TRIGGER_PX ? dy : PULL_TRIGGER_PX + (dy - PULL_TRIGGER_PX) * 0.35;
}
export const pullTriggers = (dy: number): boolean => dy >= PULL_TRIGGER_PX;

/** The parties billed most recently, by their last document, newest first, without repeats. */
export function recentPartyIds(documents: readonly Row[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...documents].sort(
    (a, b) => Number(b['updated_at']) - Number(a['updated_at']),
  )) {
    const id = d['party_id'] as string | null;
    if (!id || seen.has(id) || d['deleted_at'] != null) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/** Items sold most often, from how many lines they appear on; ties by name. */
export function favouriteItemIds(
  lines: readonly { item_id: string | null; count: number }[],
  limit = 12,
): string[] {
  return [...lines]
    .filter((l) => l.item_id)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((l) => l.item_id!);
}

/**
 * The UPI link a customer's app opens from the QR on screen (NPCI's `upi://pay`). Amount in rupees
 * with paise; the note names the document so the receipt can be matched later.
 */
export function upiLink(o: {
  upiId: string;
  payee: string;
  amountPaise: bigint | number;
  note: string;
}): string {
  const am = toDecimalString(BigInt(o.amountPaise));
  const q = new URLSearchParams({
    pa: o.upiId,
    pn: o.payee.slice(0, 50),
    am,
    cu: 'INR',
    tn: o.note.slice(0, 50),
  });
  return `upi://pay?${q.toString()}`;
}

/** How a scanned barcode is matched: exact on the barcode, then the SKU. */
export function matchBarcode(items: readonly Row[], code: string): Row | null {
  const c = code.trim();
  if (!c) return null;
  return (
    items.find((i) => String(i['barcode'] ?? '') === c) ??
    items.find((i) => String(i['sku'] ?? '').toUpperCase() === c.toUpperCase()) ??
    null
  );
}

/**
 * Whether Tier 1 extraction may run on this phone. WebGPU and a capable class are needed for the
 * browser model; otherwise the scan runs the rules here and the model step is left for a desktop or
 * the cloud (prompt 48).
 */
export function tier1OnPhone(o: { deviceClass: string; webgpu: boolean }): boolean {
  return o.webgpu && (o.deviceClass === 'capable' || o.deviceClass === 'strong');
}

/** The "Bill" tab from Home: a new bill, or the one being worked on if there is a draft open. */
export const billSearch = (openId: string | null): Record<string, string> =>
  openId ? { type: 'tax_invoice', id: openId } : { type: 'tax_invoice' };
