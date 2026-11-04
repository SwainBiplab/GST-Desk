/** Duplicate-party detection: GSTIN, phone and normalised name. Pure and browser-safe. */

export interface PartyLite {
  id: string;
  name: string;
  gstin?: string | null;
  phone?: string | null;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  /** 0..1 */
  score: number;
  reasons: ('gstin' | 'phone' | 'name' | 'similar_name')[];
}

const SUFFIXES = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'the',
  'and',
  'proprietor',
  'prop',
  'opc',
  'm/s',
  'ms',
]);

/** "M/s. Sharma & Sons Pvt. Ltd." -> "sharma sons". */
export function normaliseName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/m\/s\.?/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w));
  return words.join(' ');
}

/** Last 10 digits of a phone number, or null when there are fewer. */
export function normalisePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Dice coefficient on character bigrams. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

export function findDuplicateParties(
  candidate: Omit<PartyLite, 'id'>,
  existing: readonly PartyLite[],
  opts: { minScore?: number } = {},
): DuplicateMatch[] {
  const minScore = opts.minScore ?? 0.7;
  const gstin = candidate.gstin?.trim().toUpperCase() || null;
  const phone = normalisePhone(candidate.phone);
  const name = normaliseName(candidate.name);
  const out: DuplicateMatch[] = [];

  for (const p of existing) {
    const reasons: DuplicateMatch['reasons'] = [];
    let score = 0;
    if (gstin && p.gstin?.trim().toUpperCase() === gstin) {
      reasons.push('gstin');
      score = 1;
    }
    const pn = normaliseName(p.name);
    const nameEqual = name !== '' && pn === name;
    const sim = nameEqual ? 1 : similarity(name, pn);
    const phoneEqual = phone !== null && normalisePhone(p.phone) === phone;
    if (phoneEqual) {
      reasons.push('phone');
      score = Math.max(score, sim >= 0.5 ? 0.9 : 0.6);
    }
    if (nameEqual) {
      reasons.push('name');
      score = Math.max(score, 0.85);
    } else if (sim >= 0.8) {
      reasons.push('similar_name');
      score = Math.max(score, 0.5 + sim * 0.25);
    }
    if (score >= minScore)
      out.push({ id: p.id, name: p.name, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
