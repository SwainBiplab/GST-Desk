/**
 * The counter screen's state as pure functions (prompt 52): an index of every item by barcode and SKU so a scan
 * is a map lookup, the cart (accumulating quantity for the same item, serial numbers one to a unit), line
 * discounts that respect the cashier's limit, and the draft the document engine prices. No React and no
 * database, so each rule has a unit test and the scan-to-line path can be timed.
 */
import type { Row } from '@gst/db';
import {
  DEFAULT_WEDGE,
  buildDocument,
  discountAllowed,
  emptyDraft,
  emptyDraftLine,
  isBlankLine,
  type DraftDocument,
  type DraftLine,
  type WedgeConfig,
} from '@gst/domain';

import { applyItem, newLineKey } from '../documents/state';

export interface PosSettings {
  /** The biggest discount a cashier who cannot approve may give, in basis points. */
  maxDiscountBp: number;
  /** What the scanner is programmed to send before and after a code. */
  wedgePrefix: string;
  wedgeSuffix: 'Enter' | 'Tab' | 'none';
  /** Print the invoice QR on the receipt so a return can scan the bill. */
  billQr: boolean;
  /** Kick the cash drawer when a bill takes cash. */
  drawerKick: boolean;
}

export const DEFAULT_POS_SETTINGS: PosSettings = {
  maxDiscountBp: 500,
  wedgePrefix: '',
  wedgeSuffix: 'Enter',
  billQr: true,
  drawerKick: true,
};

export const toWedgeConfig = (s: PosSettings): WedgeConfig => ({
  ...DEFAULT_WEDGE,
  prefix: s.wedgePrefix,
  suffix: s.wedgeSuffix,
});

/* ------------------------------------------------------------------ the item index */

export interface ItemIndex {
  byBarcode: Map<string, Row>;
  bySku: Map<string, Row>;
  size: number;
}

const norm = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/** Every sellable item by barcode and by SKU. Inactive items and services without stock still sell; only inactive ones do not. */
export function buildIndex(items: readonly Row[]): ItemIndex {
  const byBarcode = new Map<string, Row>();
  const bySku = new Map<string, Row>();
  for (const it of items) {
    if (it['is_active'] === false || it['deleted_at']) continue;
    const b = norm(it['barcode']);
    const k = norm(it['sku']);
    if (b) byBarcode.set(b, it);
    if (k) bySku.set(k, it);
  }
  return { byBarcode, bySku, size: byBarcode.size + bySku.size };
}

/** What a scanned or typed code names: the barcode first, then the SKU. Null when no item has it. */
export function resolveCode(index: ItemIndex, code: string): Row | null {
  const c = norm(code);
  if (!c) return null;
  return index.byBarcode.get(c) ?? index.bySku.get(c) ?? null;
}

/* ------------------------------------------------------------------ the cart */

export const trackingOf = (item: Row): 'none' | 'batch' | 'serial' => {
  const m = String(item['tracking_mode'] ?? 'none');
  return m === 'serial' ? 'serial' : m === 'batch' ? 'batch' : 'none';
};

/**
 * Put an item on the cart. Scanning the same item again adds to its line (unless it carries serials, where
 * each serial is one unit of the same line). A new item makes a new line priced from the item.
 */
export function addToCart(
  cart: readonly DraftLine[],
  item: Row,
  opts: { qtyMicros?: bigint; serial?: string } = {},
): { cart: DraftLine[]; key: string; duplicateSerial?: boolean } {
  const qty = opts.qtyMicros ?? 1_000_000n;
  const id = String(item['id']);
  const live = cart.filter((l) => !isBlankLine(l));
  const same = live.find((l) => l.itemId === id && l.discountValue === 0n);
  if (opts.serial !== undefined) {
    const line = live.find((l) => l.itemId === id);
    if (line) {
      if (line.serials.includes(opts.serial))
        return { cart: [...live], key: line.key, duplicateSerial: true };
      const serials = [...line.serials, opts.serial];
      return {
        cart: live.map((l) =>
          l === line ? { ...l, serials, qtyMicros: BigInt(serials.length) * 1_000_000n } : l,
        ),
        key: line.key,
      };
    }
    const fresh = {
      ...applyItem(emptyDraftLine(newLineKey()), item, 'tax_invoice'),
      serials: [opts.serial],
      qtyMicros: 1_000_000n,
    };
    return { cart: [...live, fresh], key: fresh.key };
  }
  if (same && same.serials.length === 0) {
    return {
      cart: live.map((l) => (l === same ? { ...l, qtyMicros: l.qtyMicros + qty } : l)),
      key: same.key,
    };
  }
  const fresh = { ...applyItem(emptyDraftLine(newLineKey()), item, 'tax_invoice'), qtyMicros: qty };
  return { cart: [...live, fresh], key: fresh.key };
}

export function setLineQty(
  cart: readonly DraftLine[],
  key: string,
  qtyMicros: bigint,
): DraftLine[] {
  if (qtyMicros <= 0n) return cart.filter((l) => l.key !== key);
  return cart.map((l) => {
    if (l.key !== key) return l;
    // serial items move a unit to a serial: taking units off drops the last serials
    if (l.serials.length > 0) {
      const units = Number(qtyMicros / 1_000_000n);
      const serials = l.serials.slice(0, Math.max(1, units));
      return { ...l, serials, qtyMicros: BigInt(serials.length) * 1_000_000n };
    }
    return { ...l, qtyMicros };
  });
}

export const removeLine = (cart: readonly DraftLine[], key: string): DraftLine[] =>
  cart.filter((l) => l.key !== key);

/** Rupees typed as "250" or "250.50" in paise; empty is zero, and null when it is not an amount. */
export function parsePaise(text: string): bigint | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return 0n;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** A percentage typed as "5" or "7.5" in basis points, or null when it is not a percentage. */
export function parsePercentBp(text: string): number | null {
  const t = text.trim().replace(/%$/, '');
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Give a line a percentage discount, if this cashier may: the cart is unchanged when not. */
export function setLineDiscount(
  cart: readonly DraftLine[],
  key: string,
  discountBp: number,
  who: { canApprove: boolean; maxBp: number },
): { cart: DraftLine[]; allowed: boolean } {
  if (!discountAllowed({ canApprove: who.canApprove, discountBp, maxBp: who.maxBp }))
    return { cart: [...cart], allowed: false };
  return {
    cart: cart.map((l) => (l.key === key ? { ...l, discountValue: BigInt(discountBp) } : l)),
    allowed: true,
  };
}

/* ------------------------------------------------------------------ pricing */

export interface CartContext {
  businessState: string;
  composition: boolean;
  /** The customer, when one was chosen: their state decides CGST and SGST against IGST. */
  party: Row | null;
  date: string;
}

/** The draft the document engine prices; the counter's total is `buildDocument` of this. */
export function cartDraft(lines: readonly DraftLine[], ctx: CartContext): DraftDocument {
  const base = emptyDraft(ctx.composition ? 'bill_of_supply' : 'tax_invoice', ctx.date, {
    supplierState: ctx.businessState,
    composition: ctx.composition,
  });
  const live = lines.filter((l) => !isBlankLine(l));
  const state = ctx.party?.['state_code'] ? String(ctx.party['state_code']) : ctx.businessState;
  return {
    ...base,
    partyId: ctx.party ? String(ctx.party['id']) : null,
    partyName: ctx.party ? String(ctx.party['name']) : '',
    partyGstin: ctx.party?.['gstin'] ? String(ctx.party['gstin']) : null,
    partyState: ctx.party?.['state_code'] ? String(ctx.party['state_code']) : null,
    placeOfSupply: state,
    discountMode: live.some((l) => l.discountValue > 0n) ? 'percent' : 'none',
    lines: live,
  };
}

/** What the customer owes, from the engine: the same figure the bill will carry. */
export function cartTotalPaise(lines: readonly DraftLine[], ctx: CartContext): bigint {
  if (lines.filter((l) => !isBlankLine(l)).length === 0) return 0n;
  return BigInt(buildDocument(cartDraft(lines, ctx)).money.total_paise);
}

/** The quantity as a short string for the screen: 2, 0.25. */
export const qtyLabel = (micros: bigint): string => {
  const whole = micros / 1_000_000n;
  const frac = micros % 1_000_000n;
  if (frac === 0n) return String(whole);
  return `${whole}.${String(frac).padStart(6, '0').replace(/0+$/, '')}`;
};
