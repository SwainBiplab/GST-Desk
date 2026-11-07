/**
 * Tier 0 detectors: plain rules, no model, no network. Each one takes the data it needs (already loaded
 * by the caller) and returns findings. Pure and browser-safe, so they are tested with fixtures.
 */
import {
  findDuplicateParties,
  normaliseName,
  normalisePhone,
  similarity,
} from '../rules/duplicates';
import type { HsnSuggestion } from '../rules/hsn';

import type {
  BackupFailedItem,
  PrefilingIssueItem,
  DraftStaleItem,
  DuplicateItemItem,
  DuplicatePartyItem,
  ExpiryDueItem,
  HsnSuggestionItem,
  LowStockItem,
  RateChangeItem,
  ReminderDueItem,
} from './kinds';
import type { Finding } from './lifecycle';

const DAY = 86_400_000;
const IST_OFFSET = 5.5 * 3_600_000;

/** "2026-W07", by India's calendar day, so a reminder is raised once a week. */
export function isoWeekKey(now: number): string {
  const d = new Date(now + IST_OFFSET);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(now: number): string {
  return new Date(now + IST_OFFSET).toISOString().slice(0, 7);
}

const pairKey = (kind: string, a: string, b: string) => `${kind}:${[a, b].sort().join(':')}`;

/** Compare only rows that share a bucket, so 5,000 rows do not mean 12 million comparisons. */
function* pairsInBuckets<T extends { id: string }>(
  rows: readonly T[],
  bucketKeys: (r: T) => string[],
  maxBucket = 200,
): Generator<[T, T]> {
  const buckets = new Map<string, T[]>();
  for (const r of rows)
    for (const k of bucketKeys(r)) {
      const list = buckets.get(k);
      if (list) list.push(r);
      else buckets.set(k, [r]);
    }
  const done = new Set<string>();
  for (const list of buckets.values()) {
    if (list.length > maxBucket) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (done.has(k)) continue;
        done.add(k);
        yield [a, b];
      }
  }
}

export interface PartyForDup {
  id: string;
  name: string;
  gstin?: string | null;
  phone?: string | null;
  createdAt: number;
}

/** The one with a GSTIN, then the older one, is kept. */
function keepFirst<T extends { id: string; createdAt: number; gstin?: string | null }>(
  a: T,
  b: T,
): [T, T] {
  if (!!a.gstin !== !!b.gstin) return a.gstin ? [a, b] : [b, a];
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

export function detectDuplicateParties(
  parties: readonly PartyForDup[],
): Finding<DuplicatePartyItem>[] {
  const out: Finding<DuplicatePartyItem>[] = [];
  const blocks = (p: PartyForDup) => {
    const keys: string[] = [];
    if (p.gstin?.trim()) keys.push(`g:${p.gstin.trim().toUpperCase()}`);
    const ph = normalisePhone(p.phone);
    if (ph) keys.push(`p:${ph}`);
    const n = normaliseName(p.name);
    if (n.length >= 3) keys.push(`n:${n.slice(0, 4)}`);
    return keys;
  };
  for (const [a, b] of pairsInBuckets(parties, blocks)) {
    const m = findDuplicateParties(a, [b])[0];
    if (!m) continue;
    const [keep, merge] = keepFirst(a, b);
    out.push({
      kind: 'duplicate_party',
      key: pairKey('duplicate_party', a.id, b.id),
      payload: {
        keep: { id: keep.id, name: keep.name },
        merge: { id: merge.id, name: merge.name },
      },
      suggestion: {
        keepId: keep.id,
        keepName: keep.name,
        mergeId: merge.id,
        mergeName: merge.name,
        reasons: m.reasons,
      },
      confidence: m.score,
    });
  }
  return out;
}

export interface ItemForDup {
  id: string;
  name: string;
  kind: string;
  barcode?: string | null;
  createdAt: number;
}

const digitsOf = (s: string) => (s.match(/\d+/g) ?? []).join(',');

export function detectDuplicateItems(items: readonly ItemForDup[]): Finding<DuplicateItemItem>[] {
  const out: Finding<DuplicateItemItem>[] = [];
  const blocks = (i: ItemForDup) => {
    const keys: string[] = [];
    if (i.barcode?.trim()) keys.push(`b:${i.barcode.trim()}`);
    const n = normaliseName(i.name);
    if (n.length >= 3) keys.push(`n:${i.kind}:${n.slice(0, 4)}`);
    return keys;
  };
  for (const [a, b] of pairsInBuckets(items, blocks)) {
    if (a.kind !== b.kind) continue;
    const reasons: string[] = [];
    let score = 0;
    if (a.barcode?.trim() && a.barcode.trim() === b.barcode?.trim()) {
      reasons.push('barcode');
      score = 1;
    }
    const na = normaliseName(a.name).replace(/\s+/g, '');
    const nb = normaliseName(b.name).replace(/\s+/g, '');
    if (na && na === nb) {
      reasons.push('name');
      score = Math.max(score, 0.9);
    } else if (digitsOf(a.name) === digitsOf(b.name)) {
      // "Bolt 10mm" and "Bolt 12mm" are different things: sizes must agree
      const sim = similarity(na, nb);
      if (sim >= 0.9) {
        reasons.push('similar_name');
        score = Math.max(score, sim * 0.85);
      }
    }
    if (score < 0.75) continue;
    const [keep, merge] = keepFirst(a, b);
    out.push({
      kind: 'duplicate_item',
      key: pairKey('duplicate_item', a.id, b.id),
      payload: {
        keep: { id: keep.id, name: keep.name },
        merge: { id: merge.id, name: merge.name },
      },
      suggestion: {
        keepId: keep.id,
        keepName: keep.name,
        mergeId: merge.id,
        mergeName: merge.name,
        reasons,
      },
      confidence: Math.round(score * 100) / 100,
    });
  }
  return out;
}

export interface ItemForHsn {
  id: string;
  name: string;
  hsn?: string | null;
  gstRateBp: number;
  cessBp: number;
}

/** Items with no HSN: propose the best match from the master. Confidence is how far ahead it is. */
export async function detectHsnSuggestions(
  items: readonly ItemForHsn[],
  search: (text: string) => Promise<HsnSuggestion[]>,
  opts: { limit?: number } = {},
): Promise<Finding<HsnSuggestionItem>[]> {
  const out: Finding<HsnSuggestionItem>[] = [];
  for (const it of items) {
    if (it.hsn?.trim()) continue;
    if (out.length >= (opts.limit ?? 1000)) break;
    const hits = await search(it.name);
    const top = hits[0];
    if (!top) continue;
    const second = hits[1];
    const lead = second ? top.score / (top.score + second.score) : 0.9;
    const exact = normaliseName(top.description) === normaliseName(it.name);
    out.push({
      kind: 'hsn_suggestion',
      key: `hsn_suggestion:${it.id}:${top.code}`,
      payload: { itemId: it.id, name: it.name, hsn: null, gstRateBp: it.gstRateBp },
      suggestion: {
        itemId: it.id,
        itemName: it.name,
        code: top.code,
        description: top.description,
        rateBp: top.rateBp,
        cessBp: top.cessBp,
      },
      confidence: Math.min(0.99, exact ? Math.max(lead, 0.95) : lead),
    });
  }
  return out;
}

export interface RateChangeLite {
  id: string;
  name: string;
  hsn: string;
  oldRateBp: number;
  newRateBp: number;
  oldCessBp: number;
  newCessBp: number;
  effectiveFrom: string;
  due: boolean;
}

/** The master now says something different from what the item carries (and it is already in force). */
export function detectRateChanges(rows: readonly RateChangeLite[]): Finding<RateChangeItem>[] {
  return rows
    .filter((r) => r.due)
    .map((r) => ({
      kind: 'rate_change',
      key: `rate_change:${r.id}:${r.newRateBp}:${r.newCessBp}:${r.effectiveFrom}`,
      payload: { itemId: r.id, name: r.name, gstRateBp: r.oldRateBp, cessBp: r.oldCessBp },
      suggestion: {
        itemId: r.id,
        itemName: r.name,
        hsn: r.hsn,
        rateBp: r.newRateBp,
        cessBp: r.newCessBp,
        effectiveFrom: r.effectiveFrom,
      },
      confidence: 0.99,
    }));
}

export interface DraftLite {
  id: string;
  label: string;
  updatedAt: number;
}

export function detectStaleDrafts(
  drafts: readonly DraftLite[],
  now: number,
  afterDays = 7,
): Finding<DraftStaleItem>[] {
  return drafts
    .filter((d) => now - d.updatedAt > afterDays * DAY)
    .map((d) => ({
      kind: 'draft_stale',
      key: `draft_stale:${d.id}`,
      payload: { documentId: d.id },
      suggestion: {
        documentId: d.id,
        label: d.label,
        ageDays: Math.floor((now - d.updatedAt) / DAY),
      },
    }));
}

export interface OverduePartyLite {
  partyId: string;
  name: string;
  phone: string | null;
  stateCode: string | null;
  /** The language the party chose for their documents; empty means guess from the state. */
  language?: string | null;
  amountPaise: number;
  invoices: number;
  oldestDays: number;
}

export interface ReminderDeps {
  languageOf: (stateCode: string | null, chosen?: string | null) => string;
  draft: (
    language: string,
    v: { name: string; amountPaise: number; invoices: number; oldestDays: number },
  ) => string;
}

/** One reminder per customer per week, drafted in their language. Nothing is sent. */
export function detectReminders(
  parties: readonly OverduePartyLite[],
  now: number,
  deps: ReminderDeps,
): Finding<ReminderDueItem>[] {
  const week = isoWeekKey(now);
  return parties
    .filter((p) => p.amountPaise > 0 && p.oldestDays > 0)
    .map((p) => {
      const language = deps.languageOf(p.stateCode, p.language);
      return {
        kind: 'reminder_due',
        key: `reminder_due:${p.partyId}:${week}`,
        payload: { partyId: p.partyId, amountPaise: p.amountPaise },
        suggestion: {
          partyId: p.partyId,
          partyName: p.name,
          phone: p.phone,
          amountPaise: p.amountPaise,
          invoices: p.invoices,
          oldestDays: p.oldestDays,
          language,
          message: deps.draft(language, {
            name: p.name,
            amountPaise: p.amountPaise,
            invoices: p.invoices,
            oldestDays: p.oldestDays,
          }),
        },
      };
    });
}

export interface StockLite {
  id: string;
  name: string;
  onHandMicros: number;
  minMicros: number;
}

/** At or under its reorder level; asked again at most once a month per item. */
export function detectLowStock(rows: readonly StockLite[], now: number): Finding<LowStockItem>[] {
  const month = monthKey(now);
  return rows
    .filter((r) => r.minMicros > 0 && r.onHandMicros <= r.minMicros)
    .map((r) => ({
      kind: 'low_stock',
      key: `low_stock:${r.id}:${month}`,
      payload: { itemId: r.id, onHandMicros: r.onHandMicros },
      suggestion: {
        itemId: r.id,
        itemName: r.name,
        onHandMicros: r.onHandMicros,
        minMicros: r.minMicros,
      },
    }));
}

export interface ExpiryLite {
  batchId: string;
  itemId: string;
  itemName: string;
  batchNo: string;
  expiryDate: string;
  onHandMicros: number;
  daysLeft: number;
}

/** Default horizon: a batch is flagged once it is within these many days of expiry. */
export const EXPIRY_HORIZON_DAYS = 90;

/** A batch with stock expiring within the horizon, or expired; asked again at most once a month per batch. */
export function detectExpiry(
  rows: readonly ExpiryLite[],
  now: number,
  horizonDays = EXPIRY_HORIZON_DAYS,
): Finding<ExpiryDueItem>[] {
  const month = monthKey(now);
  return rows
    .filter((r) => r.onHandMicros > 0 && r.daysLeft <= horizonDays)
    .map((r) => ({
      kind: 'expiry_due',
      key: `expiry_due:${r.batchId}:${month}`,
      payload: { batchId: r.batchId, onHandMicros: r.onHandMicros, expiryDate: r.expiryDate },
      suggestion: {
        itemId: r.itemId,
        itemName: r.itemName,
        batchId: r.batchId,
        batchNo: r.batchNo,
        expiryDate: r.expiryDate,
        onHandMicros: r.onHandMicros,
        daysLeft: r.daysLeft,
      },
    }));
}

export function detectBackupFailure(
  status: { failedAt?: number | null; message?: string | null } | null,
): Finding<BackupFailedItem>[] {
  if (!status?.failedAt) return [];
  return [
    {
      kind: 'backup_failed',
      key: `backup_failed:${status.failedAt}`,
      payload: { failedAt: status.failedAt },
      suggestion: {
        failedAt: status.failedAt,
        message: status.message ?? 'The backup did not finish.',
      },
    },
  ];
}

/** A problem found by the GST return check (`GstrRepo.review`), as the inbox needs it. */
export interface PrefilingIssueLite {
  code: string;
  table: string;
  severity: 'error' | 'warning';
  message: string;
  docId?: string;
  /** The problem's own stable id from the return check; used for the card's key when present. */
  key?: string;
}

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/**
 * One card per problem in a period. The key holds the period, the problem's code, the document (or
 * table) and a hash of the wording, so two gaps in different series are two cards, and a problem that
 * is fixed closes its card by itself.
 */
export function detectPrefilingIssues(
  period: string,
  issues: readonly PrefilingIssueLite[],
): Finding<PrefilingIssueItem>[] {
  return issues.map((i) => ({
    kind: 'prefiling_issue',
    key: `prefiling_issue:${period}:${i.key ?? `${i.code}:${i.docId ?? i.table}:${hash(i.message)}`}`,
    payload: { period, table: i.table, documentId: i.docId ?? null },
    suggestion: {
      period,
      table: i.table,
      code: i.code,
      severity: i.severity,
      message: i.message,
      ...(i.docId ? { documentId: i.docId } : {}),
    },
  }));
}
