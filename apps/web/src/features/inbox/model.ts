/**
 * What an inbox row looks like, independent of React: the headline, the before/after lines, where
 * "Open record" goes, and which actions apply. Pure so it is unit tested.
 */
import { KIND_INFO, type InboxKind, type KindInfo } from '@gst/ai';
import type { Row } from '@gst/db';
import { formatBasisPoints, formatPaise } from '@gst/ui';

export interface InboxRow {
  id: string;
  version: number;
  kind: string;
  status: string;
  confidence: number | null;
  createdAt: number;
  snoozedUntil: number | null;
  rejectReason: string | null;
  suggestion: Record<string, any>;
  payload: unknown;
  row: Row;
}

export function toInboxRow(r: Row): InboxRow {
  return {
    id: r['id'],
    version: Number(r['version']),
    kind: String(r['kind']),
    status: String(r['status']),
    confidence: r['confidence'] == null ? null : Number(r['confidence']),
    createdAt: Number(r['created_at']),
    snoozedUntil: r['snoozed_until'] == null ? null : Number(r['snoozed_until']),
    rejectReason: r['reject_reason'] ?? null,
    suggestion: (r['suggestion_json'] ?? {}) as Record<string, any>,
    payload: r['payload_json'],
    row: r,
  };
}

export const kindInfo = (kind: string): KindInfo | undefined => KIND_INFO[kind as InboxKind];

export type OpenTarget =
  | { to: 'parties'; search: Record<string, unknown> }
  | { to: 'items'; search: Record<string, unknown> }
  | { to: 'document'; search: Record<string, unknown> }
  | { to: 'settings'; search: Record<string, unknown> };

export function openTarget(r: InboxRow): OpenTarget | null {
  const s = r.suggestion;
  switch (r.kind) {
    case 'duplicate_party':
      return { to: 'parties', search: { open: s['keepId'] } };
    case 'reminder_due':
      return { to: 'parties', search: { open: s['partyId'] } };
    case 'duplicate_item':
      return { to: 'items', search: { edit: s['keepId'] } };
    case 'hsn_suggestion':
    case 'rate_change':
    case 'low_stock':
      return { to: 'items', search: { edit: s['itemId'] } };
    case 'draft_stale':
      return { to: 'document', search: { id: s['documentId'] } };
    case 'backup_failed':
      return { to: 'settings', search: { tab: 'backup' } };
    default:
      return null;
  }
}

export interface DiffLine {
  label: string;
  before: string;
  after: string;
}

const units = (micros: number) => String(Math.round(micros / 10_000) / 100);

/** The lines that show what accepting would change (empty for kinds that only acknowledge). */
export function diffLines(r: InboxRow): DiffLine[] {
  const s = r.suggestion;
  const p = (r.payload ?? {}) as Record<string, any>;
  switch (r.kind) {
    case 'hsn_suggestion':
      return [
        { label: 'HSN', before: p['hsn'] || '—', after: s['code'] },
        {
          label: 'GST',
          before: p['gstRateBp'] == null ? '—' : formatBasisPoints(p['gstRateBp']),
          after: formatBasisPoints(s['rateBp']),
        },
      ];
    case 'rate_change':
      return [
        {
          label: 'GST',
          before: p['gstRateBp'] == null ? '—' : formatBasisPoints(p['gstRateBp']),
          after: formatBasisPoints(s['rateBp']),
        },
        ...(Number(p['cessBp'] ?? 0) !== Number(s['cessBp'] ?? 0)
          ? [
              {
                label: 'Cess',
                before: formatBasisPoints(Number(p['cessBp'] ?? 0)),
                after: formatBasisPoints(Number(s['cessBp'] ?? 0)),
              },
            ]
          : []),
      ];
    case 'duplicate_party':
    case 'duplicate_item':
      return [
        { label: 'Keep', before: s['keepName'], after: s['keepName'] },
        { label: 'Merge in', before: s['mergeName'], after: '→ ' + s['keepName'] },
      ];
    default:
      return [];
  }
}

/** Interpolation values for `inbox.describe.<kind>`. */
export function describeArgs(r: InboxRow): Record<string, unknown> {
  const s = r.suggestion;
  switch (r.kind) {
    case 'duplicate_party':
    case 'duplicate_item':
      return { keep: s['keepName'], merge: s['mergeName'] };
    case 'hsn_suggestion':
      return { item: s['itemName'], code: s['code'], rate: formatBasisPoints(s['rateBp']) };
    case 'rate_change':
      return {
        item: s['itemName'],
        rate: formatBasisPoints(s['rateBp']),
        date: s['effectiveFrom'],
        hsn: s['hsn'],
      };
    case 'reminder_due':
      return {
        party: s['partyName'],
        amount: formatPaise(s['amountPaise']),
        count: s['invoices'],
        days: s['oldestDays'],
      };
    case 'low_stock':
      return { item: s['itemName'], onHand: units(s['onHandMicros']), min: units(s['minMicros']) };
    case 'draft_stale':
      return { label: s['label'], days: s['ageDays'] };
    case 'backup_failed':
      return { message: s['message'] };
    default:
      return {};
  }
}

/** A short headline: the thing the item is about. */
export function headline(r: InboxRow): string {
  const s = r.suggestion;
  return String(
    s['partyName'] ?? s['itemName'] ?? s['keepName'] ?? s['label'] ?? s['message'] ?? r.kind,
  );
}

export interface Filters {
  kind: string;
  search: string;
}

/** The rows of one view (already split by the database) that match the kind and the search box. */
export function filterRows(rows: readonly InboxRow[], f: Filters): InboxRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind !== 'all' && r.kind !== f.kind) return false;
    if (!q) return true;
    return (
      headline(r).toLowerCase().includes(q) ||
      String(r.suggestion['mergeName'] ?? '')
        .toLowerCase()
        .includes(q) ||
      r.kind.includes(q)
    );
  });
}

/** Whether Accept can do anything for this kind yet. */
export function canAccept(r: InboxRow): boolean {
  const info = kindInfo(r.kind);
  return !!info && !info.pending && r.status === 'pending';
}

/** Fields a person may change before accepting, per kind. */
export type EditField = 'code' | 'message' | 'keep';
export function editableFields(kind: string): EditField[] {
  if (kind === 'hsn_suggestion') return ['code'];
  if (kind === 'reminder_due') return ['message'];
  if (kind === 'duplicate_party' || kind === 'duplicate_item') return ['keep'];
  return [];
}

export const whatsappUrl = (phone: string | null, message: string): string => {
  const digits = (phone ?? '').replace(/\D/g, '');
  const to = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(message)}`;
};
