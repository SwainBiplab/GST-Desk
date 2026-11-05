/**
 * The life of a review item. Pure, so the same rules run in the tests, the job runner and the screens.
 *
 *   pending ──accept──▶ accepted
 *      │ ──reject──▶ rejected
 *      └── condition no longer true ──▶ expired
 *   pending + snoozed_until in the future = hidden, then open again by itself
 *
 * Accepted, rejected and expired items are final and are never raised again for the same key: a person
 * who said "no" is not asked again, and a finding that cleared and came back later is a new key (the
 * keys carry the period or the value they are about).
 */
export type ReviewStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

const NEXT: Record<ReviewStatus, readonly ReviewStatus[]> = {
  pending: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: [],
  expired: [],
};

export function canMove(from: ReviewStatus, to: ReviewStatus): boolean {
  return NEXT[from].includes(to);
}

export type Visibility = 'open' | 'snoozed' | 'done';

export function visibilityOf(
  item: { status: string; snoozedUntil?: number | null },
  now: number,
): Visibility {
  if (item.status !== 'pending') return 'done';
  return item.snoozedUntil != null && item.snoozedUntil > now ? 'snoozed' : 'open';
}

/** One thing a detector found. `key` names what it is about, and is what makes a run idempotent. */
export interface Finding<T = Record<string, unknown>> {
  kind: string;
  key: string;
  /** The user's data the suggestion is about, for the diff. */
  payload: unknown;
  suggestion: T;
  /** 0..1 */
  confidence?: number;
}

export interface SeenLite {
  id: string;
  status: string;
  version: number;
  kind: string;
}

export interface Reconciled<T = Record<string, unknown>> {
  /** Findings never seen before. */
  create: Finding<T>[];
  /** Waiting items whose finding is gone (the condition cleared). */
  expire: SeenLite[];
}

/**
 * Compare what the detectors found now with everything raised before. `ran` lists the kinds whose
 * detectors actually ran, so a kind that was skipped is never mistaken for "all clear".
 */
export function reconcile<T>(
  seen: ReadonlyMap<string, SeenLite>,
  findings: readonly Finding<T>[],
  ran: readonly string[],
): Reconciled<T> {
  const found = new Set<string>();
  const create: Finding<T>[] = [];
  for (const f of findings) {
    if (found.has(f.key)) continue;
    found.add(f.key);
    if (!seen.has(f.key)) create.push(f);
  }
  const kinds = new Set(ran);
  const expire: SeenLite[] = [];
  for (const [key, s] of seen) {
    if (s.status === 'pending' && kinds.has(s.kind) && !found.has(key)) expire.push(s);
  }
  return { create, expire };
}

/** Preset snooze lengths, in milliseconds. */
export const SNOOZE_PRESETS = [
  { id: 'tomorrow', label: 'Tomorrow', ms: 24 * 3_600_000 },
  { id: 'week', label: 'Next week', ms: 7 * 24 * 3_600_000 },
  { id: 'month', label: 'Next month', ms: 30 * 24 * 3_600_000 },
] as const;
