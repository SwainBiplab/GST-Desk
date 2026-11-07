/**
 * Matching what a bill says to what the books hold: the supplier by GSTIN (exact) or name (fuzzy), each
 * line to a catalogue item by name, then HSN and rate as tie-breakers. A match is a proposal with a score;
 * nothing below the floor is offered.
 */

export interface PartyRef {
  id: string;
  name: string;
  gstin: string | null;
}

export interface ItemRef {
  id: string;
  name: string;
  hsn: string | null;
  purchaseRatePaise: number;
  gstRateBp: number;
}

const SUFFIX = /\b(pvt|private|ltd|limited|llp|co|company|inc|the|m\/s|ms)\b/g;

/** Lowercase letters and digits only, company suffixes dropped. */
export const normName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(SUFFIX, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s.replace(/\s+/g, ' ')} `;
  for (let i = 0; i + 2 <= t.length; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let shared = 0;
  let total = 0;
  for (const [g, n] of ga) {
    total += n;
    shared += Math.min(n, gb.get(g) ?? 0);
  }
  for (const n of gb.values()) total += n;
  return total ? (2 * shared) / total : 0;
}

export interface SupplierMatch {
  partyId: string | null;
  name: string;
  score: number;
  by: 'gstin' | 'name' | 'none';
}

export function matchSupplier(
  bill: { supplierName: string; supplierGstin: string | null },
  parties: PartyRef[],
  floor = 0.72,
): SupplierMatch {
  if (bill.supplierGstin) {
    const g = bill.supplierGstin.toUpperCase();
    const p = parties.find((x) => (x.gstin ?? '').toUpperCase() === g);
    if (p) return { partyId: p.id, name: p.name, score: 1, by: 'gstin' };
  }
  let best: SupplierMatch = { partyId: null, name: bill.supplierName, score: 0, by: 'none' };
  for (const p of parties) {
    const s = nameSimilarity(bill.supplierName, p.name);
    if (s > best.score) best = { partyId: p.id, name: p.name, score: s, by: 'name' };
  }
  return best.score >= floor
    ? best
    : { partyId: null, name: bill.supplierName, score: best.score, by: 'none' };
}

export interface ItemMatch {
  itemId: string | null;
  name: string;
  score: number;
}

export function matchItem(
  line: { description: string; hsn: string | null; ratePaise: number; gstRateBp: number },
  items: ItemRef[],
  floor = 0.62,
): ItemMatch {
  let best: ItemMatch = { itemId: null, name: line.description, score: 0 };
  for (const it of items) {
    let s = nameSimilarity(line.description, it.name);
    if (s < 0.3) continue;
    if (line.hsn && it.hsn && line.hsn === it.hsn) s += 0.1;
    if (it.purchaseRatePaise && line.ratePaise) {
      const gap =
        Math.abs(it.purchaseRatePaise - line.ratePaise) /
        Math.max(it.purchaseRatePaise, line.ratePaise);
      if (gap < 0.05) s += 0.08;
    }
    if (line.gstRateBp && it.gstRateBp === line.gstRateBp) s += 0.03;
    s = Math.min(1, s);
    if (s > best.score) best = { itemId: it.id, name: it.name, score: s };
  }
  return best.score >= floor ? best : { itemId: null, name: line.description, score: best.score };
}
