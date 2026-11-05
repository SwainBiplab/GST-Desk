/**
 * What can land in the review inbox, and the shape of each suggestion. Browser-safe: the screens and
 * the detectors both import this. Applying a suggestion lives in `@gst/ai/db` (`applyReviewItem`).
 */
import { z } from 'zod';

export const INBOX_KINDS = [
  'ai_extraction',
  'duplicate_party',
  'duplicate_item',
  'hsn_suggestion',
  'prefiling_issue',
  'reconciliation_mismatch',
  'sync_conflict',
  'reminder_due',
  'low_stock',
  'draft_stale',
  'backup_failed',
  'rate_change',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Kinds the Tier 0 rules raise. The rest belong to later prompts and only show up when they arrive. */
export const TIER0_KINDS = [
  'duplicate_party',
  'duplicate_item',
  'hsn_suggestion',
  'reminder_due',
  'low_stock',
  'draft_stale',
  'backup_failed',
  'rate_change',
] as const satisfies readonly InboxKind[];

export const duplicatePartyItem = z.object({
  /** The party that stays. */
  keepId: z.string(),
  keepName: z.string(),
  /** The party folded into it. */
  mergeId: z.string(),
  mergeName: z.string(),
  reasons: z.array(z.string()),
});
export type DuplicatePartyItem = z.infer<typeof duplicatePartyItem>;

export const duplicateItemItem = z.object({
  keepId: z.string(),
  keepName: z.string(),
  mergeId: z.string(),
  mergeName: z.string(),
  reasons: z.array(z.string()),
});
export type DuplicateItemItem = z.infer<typeof duplicateItemItem>;

export const hsnSuggestionItem = z.object({
  itemId: z.string(),
  itemName: z.string(),
  code: z.string(),
  description: z.string(),
  rateBp: z.number().int(),
  cessBp: z.number().int(),
});
export type HsnSuggestionItem = z.infer<typeof hsnSuggestionItem>;

export const rateChangeItem = z.object({
  itemId: z.string(),
  itemName: z.string(),
  hsn: z.string(),
  rateBp: z.number().int(),
  cessBp: z.number().int(),
  effectiveFrom: z.string(),
});
export type RateChangeItem = z.infer<typeof rateChangeItem>;

export const reminderDueItem = z.object({
  partyId: z.string(),
  partyName: z.string(),
  phone: z.string().nullable(),
  amountPaise: z.number().int(),
  invoices: z.number().int(),
  oldestDays: z.number().int(),
  language: z.string(),
  /** The drafted message, in the customer's language. People edit it before it is sent. */
  message: z.string(),
});
export type ReminderDueItem = z.infer<typeof reminderDueItem>;

export const draftStaleItem = z.object({
  documentId: z.string(),
  label: z.string(),
  ageDays: z.number().int(),
});
export type DraftStaleItem = z.infer<typeof draftStaleItem>;

export const lowStockItem = z.object({
  itemId: z.string(),
  itemName: z.string(),
  onHandMicros: z.number(),
  minMicros: z.number(),
});
export type LowStockItem = z.infer<typeof lowStockItem>;

export const backupFailedItem = z.object({
  failedAt: z.number(),
  message: z.string(),
});
export type BackupFailedItem = z.infer<typeof backupFailedItem>;

/** Kinds whose owner has not shipped yet: the card shows what it holds, Accept stays off. */
export const genericItem = z.record(z.string(), z.unknown());

export const INBOX_SCHEMAS = {
  duplicate_party: duplicatePartyItem,
  duplicate_item: duplicateItemItem,
  hsn_suggestion: hsnSuggestionItem,
  rate_change: rateChangeItem,
  reminder_due: reminderDueItem,
  draft_stale: draftStaleItem,
  low_stock: lowStockItem,
  backup_failed: backupFailedItem,
  ai_extraction: genericItem,
  prefiling_issue: genericItem,
  reconciliation_mismatch: genericItem,
  sync_conflict: genericItem,
} as const satisfies Record<InboxKind, z.ZodType>;

export function schemaFor(kind: string): z.ZodType<Record<string, unknown>> {
  return (INBOX_SCHEMAS as Record<string, z.ZodType>)[kind] as z.ZodType<Record<string, unknown>>;
}

export interface KindInfo {
  /** Message key suffix for the label, and a plain English fallback. */
  label: string;
  /** Accepting only acknowledges: there is nothing to apply. */
  informational: boolean;
  /** Safe to accept many at once, with a preview. */
  bulk: boolean;
  /** Not built yet: Accept is disabled with a note. */
  pending?: string;
  /** Where "Open record" goes. */
  opens: 'party' | 'item' | 'document' | 'settings' | 'none';
}

export const KIND_INFO: Record<InboxKind, KindInfo> = {
  ai_extraction: {
    label: 'Extracted document',
    informational: false,
    bulk: false,
    pending: 'prompt 36',
    opens: 'none',
  },
  duplicate_party: {
    label: 'Possible duplicate party',
    informational: false,
    bulk: false,
    opens: 'party',
  },
  duplicate_item: {
    label: 'Possible duplicate item',
    informational: false,
    bulk: false,
    opens: 'item',
  },
  hsn_suggestion: { label: 'HSN suggestion', informational: false, bulk: true, opens: 'item' },
  prefiling_issue: {
    label: 'Filing check',
    informational: false,
    bulk: false,
    pending: 'phase 2',
    opens: 'none',
  },
  reconciliation_mismatch: {
    label: 'Reconciliation mismatch',
    informational: false,
    bulk: false,
    pending: 'phase 2',
    opens: 'none',
  },
  sync_conflict: {
    label: 'Sync conflict',
    informational: false,
    bulk: false,
    pending: 'phase 3',
    opens: 'none',
  },
  reminder_due: { label: 'Payment reminder', informational: false, bulk: false, opens: 'party' },
  low_stock: { label: 'Low stock', informational: true, bulk: false, opens: 'item' },
  draft_stale: { label: 'Old draft', informational: true, bulk: false, opens: 'document' },
  backup_failed: { label: 'Backup failed', informational: true, bulk: false, opens: 'settings' },
  rate_change: { label: 'GST rate changed', informational: false, bulk: true, opens: 'item' },
};

/** A suggestion at or above this confidence (percent) can be bulk-accepted. */
export const BULK_MIN_CONFIDENCE = 90;
