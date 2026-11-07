/**
 * Picking stock for a document line (prompt 51, FR-111): which batches a sale takes from when nobody
 * chose (first expiry, first out), and how a pasted or scanned list of serial numbers is read and
 * checked. Pure functions; the repository supplies what is on hand.
 */

export const TRACKING_MODES = ['none', 'batch', 'serial'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const isTrackingMode = (v: unknown): v is TrackingMode =>
  v === 'none' || v === 'batch' || v === 'serial';

export interface BatchStock {
  batchId: string;
  batchNo: string;
  /** ISO date or null when the batch does not expire. */
  expiryDate: string | null;
  availableMicros: number;
}

export interface Pick {
  batchId: string;
  qtyMicros: number;
}

export interface FefoResult {
  picks: Pick[];
  /** What could not be found in any usable batch. */
  shortMicros: number;
  /** Batches passed over because they had expired. */
  expiredSkipped: number;
}

/** Whether a batch has expired on `today` (an expiry date of today is still good). */
export const isExpired = (expiryDate: string | null, today: string): boolean =>
  expiryDate !== null && expiryDate < today;

/** Batches in the order a sale should take them: earliest expiry first, batches without one last. */
export function fefoOrder<T extends { expiryDate: string | null; batchNo: string }>(
  batches: readonly T[],
): T[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate === b.expiryDate) return a.batchNo.localeCompare(b.batchNo);
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  });
}

/**
 * Fill `needMicros` from the batches that have stock, first expiry first. Expired batches are passed
 * over unless `allowExpired`; a shortfall is reported, never silently taken from nowhere.
 */
export function pickFefo(
  batches: readonly BatchStock[],
  needMicros: number,
  opts: { today: string; allowExpired?: boolean },
): FefoResult {
  const picks: Pick[] = [];
  let left = needMicros;
  let expiredSkipped = 0;
  for (const b of fefoOrder(batches)) {
    if (left <= 0) break;
    if (b.availableMicros <= 0) continue;
    if (!opts.allowExpired && isExpired(b.expiryDate, opts.today)) {
      expiredSkipped++;
      continue;
    }
    const take = Math.min(left, b.availableMicros);
    picks.push({ batchId: b.batchId, qtyMicros: take });
    left -= take;
  }
  return { picks, shortMicros: Math.max(0, left), expiredSkipped };
}

/** Serial numbers from a scan or a paste: one per line, comma, semicolon or whitespace. */
export function parseSerials(text: string): { serials: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const serials: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim();
    if (s === '') continue;
    if (seen.has(s)) {
      if (!duplicates.includes(s)) duplicates.push(s);
      continue;
    }
    seen.add(s);
    serials.push(s);
  }
  return { serials, duplicates };
}

export type SerialState = 'in_stock' | 'out';

export interface SerialCheck {
  /** Serials a sale asked for that are not in stock (unknown, or already sold). */
  unavailable: string[];
  /** Serials a purchase brings in that are already in stock. */
  alreadyIn: string[];
}

/**
 * Whether a list of serials can move the way the document says: out needs each one in stock, in needs
 * each one not already there (a sold serial may come back).
 */
export function checkSerials(
  serials: readonly string[],
  states: ReadonlyMap<string, SerialState>,
  direction: 'in' | 'out',
): SerialCheck {
  const unavailable: string[] = [];
  const alreadyIn: string[] = [];
  for (const s of serials) {
    const st = states.get(s);
    if (direction === 'out' && st !== 'in_stock') unavailable.push(s);
    if (direction === 'in' && st === 'in_stock') alreadyIn.push(s);
  }
  return { unavailable, alreadyIn };
}

/** Serial items move one unit per serial: the line's quantity must equal the count of serials. */
export const serialCountMatches = (serials: readonly string[], qtyMicros: number): boolean =>
  serials.length * 1_000_000 === qtyMicros;
