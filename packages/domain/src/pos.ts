/**
 * Counter billing rules (prompt 52, FR-113 and FR-114). Pure functions and one small state machine:
 * reading a keyboard-wedge barcode scanner, splitting a bill over payment modes with change, working out
 * what a shift's drawer should hold and the variance on close, the Z report, a weighing scale's line, and
 * the code on a printed bill. Money is paise as BigInt, quantities millionths of a unit. Nothing here
 * touches a database or a screen, so each rule has a unit test.
 */
import { divRound } from './money';

/* ------------------------------------------------------------------ scanner (keyboard wedge) */

export interface WedgeConfig {
  /** Text the scanner sends before the code (a programmed prefix); empty for none. */
  prefix: string;
  /** The key the scanner ends with: Enter, Tab, or nothing (then a pause ends the code). */
  suffix: 'Enter' | 'Tab' | 'none';
  /** The longest gap between two keys of one scan; people type slower than this. */
  maxGapMs: number;
  /** Shorter than this is typing, not a scan. */
  minLength: number;
  /** With no suffix, the pause after the last key that ends the code. */
  idleMs: number;
}

export const DEFAULT_WEDGE: WedgeConfig = {
  prefix: '',
  suffix: 'Enter',
  maxGapMs: 50,
  minLength: 3,
  idleMs: 80,
};

export type WedgeResult = { kind: 'scan'; text: string } | { kind: 'typed'; text: string };

/**
 * A USB scanner types its code as keystrokes a few milliseconds apart and ends with Enter (or Tab).
 * Feed every key with its time: when the ending key arrives the text is either a scan (every gap short
 * enough, long enough, the prefix present and removed) or something a person typed. With no ending key
 * `flush` ends the code after a pause.
 */
export class WedgeParser {
  private buf = '';
  private last = 0;
  private fast = true;

  constructor(private readonly cfg: WedgeConfig = DEFAULT_WEDGE) {}

  /** A printable key (one character) or the name of the ending key. */
  push(key: string, t: number): WedgeResult | null {
    const ending = this.cfg.suffix !== 'none' && key === this.cfg.suffix;
    if (!ending && key.length !== 1) return null;
    if (this.buf !== '' && t - this.last > this.cfg.maxGapMs) this.fast = false;
    if (ending) return this.finish();
    if (this.buf === '') this.fast = true;
    this.buf += key;
    this.last = t;
    return null;
  }

  /** With no ending key: a scan that has gone quiet is complete. */
  flush(t: number): WedgeResult | null {
    if (this.cfg.suffix !== 'none' || this.buf === '' || t - this.last < this.cfg.idleMs)
      return null;
    return this.finish();
  }

  /** Throw away what has been collected (a dialog opened, focus moved). */
  reset(): void {
    this.buf = '';
    this.fast = true;
  }

  private finish(): WedgeResult | null {
    const raw = this.buf;
    const fast = this.fast;
    this.reset();
    if (raw === '') return null;
    const { prefix } = this.cfg;
    if (prefix) {
      if (!raw.startsWith(prefix)) return { kind: 'typed', text: raw };
      const text = raw.slice(prefix.length);
      return text === '' ? null : { kind: 'scan', text };
    }
    return fast && raw.length >= this.cfg.minLength
      ? { kind: 'scan', text: raw }
      : { kind: 'typed', text: raw };
  }
}

/** Remove a programmed prefix and suffix from a code that arrived whole (a camera, a paste). */
export function stripWedge(
  raw: string,
  cfg: Pick<WedgeConfig, 'prefix'> & { suffix?: string },
): string {
  let s = raw.replace(/[\r\n\t]+$/g, '');
  if (cfg.prefix && s.startsWith(cfg.prefix)) s = s.slice(cfg.prefix.length);
  if (
    cfg.suffix &&
    cfg.suffix !== 'none' &&
    cfg.suffix !== 'Enter' &&
    cfg.suffix !== 'Tab' &&
    s.endsWith(cfg.suffix)
  )
    s = s.slice(0, -cfg.suffix.length);
  return s.trim();
}

/* ------------------------------------------------------------------ what a scan means */

/**
 * The bill a scanned code points at. The printed invoice's QR carries `GSTIN|number|date|total`;
 * a receipt may print `number` alone. Returns the invoice number, or null for an empty scan.
 */
export function parseBillCode(text: string): string | null {
  const s = text.trim();
  if (s === '') return null;
  if (s.includes('|')) {
    const parts = s.split('|').map((p) => p.trim());
    return parts[1] && parts[1] !== '' ? parts[1] : null;
  }
  return s;
}

/**
 * A line from a serial scale: "ST,GS,   0.250kg", "  1.250 kg", "W:0.5kg", "250 g". Returns the weight in
 * millionths of a kilogram and whether the scale called it stable (a reading with no marker counts as stable).
 */
export function parseScaleReading(line: string): { kgMicros: number; stable: boolean } | null {
  const m = /(-?\d+(?:[.,]\d+)?)\s*(kg|g)\b/i.exec(line);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  const kg = m[2]!.toLowerCase() === 'g' ? n / 1000 : n;
  const unstable = /(^|[,\s])(US|UN|MO)([,\s]|$)/i.test(line);
  return { kgMicros: Math.round(kg * 1_000_000), stable: !unstable };
}

/* ------------------------------------------------------------------ paying a bill */

export const TENDER_MODES = ['cash', 'upi', 'card', 'other'] as const;
export type TenderMode = (typeof TENDER_MODES)[number];

export interface Tender {
  mode: TenderMode;
  /** What was handed over (cash may be more than is due) or authorised (card, UPI: exact). */
  amountPaise: bigint;
  /** A UPI transaction id or a card approval code. */
  reference?: string;
}

export interface TenderSettlement {
  ok: boolean;
  /** What each tender settles, in the order given: cash less the change, the others as they are. */
  applied: { mode: TenderMode; amountPaise: bigint; reference: string }[];
  changePaise: bigint;
  /** Still to pay when the tenders fall short. */
  shortPaise: bigint;
  errors: ('no_tender' | 'bad_amount' | 'over_noncash' | 'short' | 'nothing_due')[];
}

/**
 * Split a bill over payment modes. Card and UPI settle exactly what they are for, so together they cannot
 * exceed what is due; cash settles the rest and anything above that is change. Short of the total, the
 * bill is not paid (`short`); the screen can still show how much is left.
 */
export function settleTenders(duePaise: bigint, tenders: readonly Tender[]): TenderSettlement {
  const errors: TenderSettlement['errors'] = [];
  const live = tenders.filter((t) => t.amountPaise !== 0n);
  if (duePaise <= 0n) errors.push('nothing_due');
  if (live.length === 0) errors.push('no_tender');
  if (live.some((t) => t.amountPaise < 0n)) errors.push('bad_amount');
  const nonCash = live
    .filter((t) => t.mode !== 'cash' && t.amountPaise > 0n)
    .reduce((s, t) => s + t.amountPaise, 0n);
  if (nonCash > duePaise) errors.push('over_noncash');
  const cashIn = live
    .filter((t) => t.mode === 'cash' && t.amountPaise > 0n)
    .reduce((s, t) => s + t.amountPaise, 0n);
  const cashDue = nonCash > duePaise ? 0n : duePaise - nonCash;
  const cashApplied = cashIn < cashDue ? cashIn : cashDue;
  const changePaise = cashIn - cashApplied;
  const settled = nonCash + cashApplied;
  const shortPaise = duePaise > settled ? duePaise - settled : 0n;
  if (shortPaise > 0n && duePaise > 0n && live.length > 0 && !errors.includes('over_noncash'))
    errors.push('short');
  // cash tenders share the applied cash in the order given
  let cashLeft = cashApplied;
  const applied = live
    .filter((t) => t.amountPaise > 0n)
    .map((t) => {
      if (t.mode !== 'cash')
        return { mode: t.mode, amountPaise: t.amountPaise, reference: t.reference ?? '' };
      const take = t.amountPaise < cashLeft ? t.amountPaise : cashLeft;
      cashLeft -= take;
      return { mode: t.mode, amountPaise: take, reference: t.reference ?? '' };
    })
    .filter((a) => a.amountPaise > 0n);
  return { ok: errors.length === 0, applied, changePaise, shortPaise, errors };
}

/** Amounts a customer commonly hands over for a total: the exact sum and the next notes up. */
export function cashSuggestions(duePaise: bigint): bigint[] {
  if (duePaise <= 0n) return [];
  const notes = [10n, 20n, 50n, 100n, 200n, 500n, 2000n].map((n) => n * 100n);
  const out = new Set<bigint>([duePaise]);
  for (const n of notes) {
    const up = ((duePaise + n - 1n) / n) * n;
    if (up > duePaise) out.add(up);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 4);
}

/* ------------------------------------------------------------------ discounts */

/**
 * Whether a cashier may give this discount. Anyone who can approve may give any; the rest up to the
 * business's limit (a limit of zero means they may not discount at all).
 */
export function discountAllowed(o: {
  canApprove: boolean;
  discountBp: number;
  maxBp: number;
}): boolean {
  if (o.discountBp < 0 || o.discountBp > 10_000) return false;
  return o.canApprove || o.discountBp <= o.maxBp;
}

/* ------------------------------------------------------------------ shifts and the Z report */

export interface DrawerFacts {
  floatPaise: bigint;
  /** Cash settled on bills (change already taken off). */
  cashSalesPaise: bigint;
  /** Cash given back on returns. */
  cashRefundsPaise: bigint;
  /** Cash put in or taken out by hand (a float top-up, a bank run, petty cash). */
  cashInPaise: bigint;
  cashOutPaise: bigint;
}

/** What the drawer should hold. */
export const expectedCash = (f: DrawerFacts): bigint =>
  f.floatPaise + f.cashSalesPaise - f.cashRefundsPaise + f.cashInPaise - f.cashOutPaise;

export interface Variance {
  /** Counted less expected: negative is short. */
  variancePaise: bigint;
  status: 'balanced' | 'short' | 'over';
}

export function closeVariance(expectedPaise: bigint, countedPaise: bigint): Variance {
  const variancePaise = countedPaise - expectedPaise;
  return {
    variancePaise,
    status: variancePaise === 0n ? 'balanced' : variancePaise < 0n ? 'short' : 'over',
  };
}

/** One bill as the Z report sees it. */
export interface BillFacts {
  kind: 'sale' | 'return';
  totalPaise: bigint;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  /** What was settled (sale) or given back (return), by mode. */
  tenders: { mode: TenderMode; amountPaise: bigint }[];
}

export interface ZReport {
  salesCount: number;
  returnsCount: number;
  salesPaise: bigint;
  returnsPaise: bigint;
  netPaise: bigint;
  /** Net by payment mode: received less refunded. */
  byMode: Record<TenderMode, bigint>;
  tax: {
    taxablePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    cessPaise: bigint;
  };
  drawer: DrawerFacts & { expectedPaise: bigint };
}

/** The shift's or the day's summary: sales and returns, takings by mode, tax, and the drawer. */
export function buildZReport(
  bills: readonly BillFacts[],
  movements: { kind: 'in' | 'out'; amountPaise: bigint }[],
  floatPaise: bigint,
): ZReport {
  const byMode: Record<TenderMode, bigint> = { cash: 0n, upi: 0n, card: 0n, other: 0n };
  const tax = { taxablePaise: 0n, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n, cessPaise: 0n };
  let salesCount = 0;
  let returnsCount = 0;
  let salesPaise = 0n;
  let returnsPaise = 0n;
  let cashSales = 0n;
  let cashRefunds = 0n;
  for (const b of bills) {
    const sign = b.kind === 'sale' ? 1n : -1n;
    if (b.kind === 'sale') {
      salesCount++;
      salesPaise += b.totalPaise;
    } else {
      returnsCount++;
      returnsPaise += b.totalPaise;
    }
    tax.taxablePaise += sign * b.taxablePaise;
    tax.cgstPaise += sign * b.cgstPaise;
    tax.sgstPaise += sign * b.sgstPaise;
    tax.igstPaise += sign * b.igstPaise;
    tax.cessPaise += sign * b.cessPaise;
    for (const t of b.tenders) {
      byMode[t.mode] += sign * t.amountPaise;
      if (t.mode === 'cash') {
        if (b.kind === 'sale') cashSales += t.amountPaise;
        else cashRefunds += t.amountPaise;
      }
    }
  }
  const cashIn = movements.filter((m) => m.kind === 'in').reduce((s, m) => s + m.amountPaise, 0n);
  const cashOut = movements.filter((m) => m.kind === 'out').reduce((s, m) => s + m.amountPaise, 0n);
  const facts: DrawerFacts = {
    floatPaise,
    cashSalesPaise: cashSales,
    cashRefundsPaise: cashRefunds,
    cashInPaise: cashIn,
    cashOutPaise: cashOut,
  };
  return {
    salesCount,
    returnsCount,
    salesPaise,
    returnsPaise,
    netPaise: salesPaise - returnsPaise,
    byMode,
    tax,
    drawer: { ...facts, expectedPaise: expectedCash(facts) },
  };
}

/** A discount in basis points off a rate, for showing a price tag. */
export const afterDiscount = (ratePaise: bigint, discountBp: number): bigint =>
  ratePaise - divRound(ratePaise * BigInt(discountBp), 10_000n);
