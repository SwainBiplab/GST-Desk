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
  'approval_request',
  'recurring_failed',
  'payment_attention',
  'filing_attention',
  'reminder_due',
  'low_stock',
  'draft_stale',
  'backup_failed',
  'rate_change',
  'gsp_job_stopped',
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
  'prefiling_issue',
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

/** A request to the GST portal (an IRN or an e-way bill) stopped because its document changed. */
export const gspJobStoppedItem = z.object({
  documentId: z.string(),
  number: z.string(),
  job: z.string(),
  message: z.string(),
});
export type GspJobStoppedItem = z.infer<typeof gspJobStoppedItem>;

/** A problem the GST return check found in a period (a mistake in a document, a missing code, a gap). */
export const prefilingIssueItem = z.object({
  /** Return period, MMYYYY. */
  period: z.string(),
  table: z.string(),
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  documentId: z.string().optional(),
});
export type PrefilingIssueItem = z.infer<typeof prefilingIssueItem>;

/**
 * A purchase bill read from a scan (prompt 36). Accepting makes a purchase draft under `documentId` with
 * the scan attached; the person issues it from the editor. Every field carries the confidence it was read with.
 */
export const aiExtractionItem = z.object({
  /** The id the draft will have, chosen before accept so the card can open it afterwards. */
  documentId: z.string(),
  bill: z.object({
    supplierName: z.string(),
    supplierGstin: z.string().nullable(),
    invoiceNumber: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z.array(
      z.object({
        description: z.string(),
        hsn: z.string().nullable(),
        qty: z.number(),
        ratePaise: z.number().int(),
        gstRateBp: z.number().int(),
        /** The catalogue item it was matched to, or null for a free line. */
        itemId: z.string().nullable(),
      }),
    ),
    totalPaise: z.number().int(),
  }),
  supplierPartyId: z.string().nullable(),
  fieldConfidence: z.record(z.string(), z.number()),
  checks: z.object({
    engineTotalPaise: z.number().int(),
    totalsAgree: z.boolean(),
    gstinValid: z.boolean().nullable(),
    dateSane: z.boolean(),
  }),
  /** The scan, already stored by the app; registered against the draft on accept. */
  attachment: z
    .object({
      fileName: z.string(),
      mime: z.string(),
      sizeBytes: z.number().int(),
      sha256: z.string(),
      storagePath: z.string(),
    })
    .nullable(),
  sources: z.array(z.string()),
  model: z.string().nullable(),
});
export type AiExtractionItem = z.infer<typeof aiExtractionItem>;

/**
 * Two devices changed the same thing while apart (prompt 41). The server kept one version (`theirs`) and
 * this item keeps the other (`mine`) with the whole local transaction it came in (`ops`). Accepting keeps
 * mine: it is applied again on top of what the server holds. Rejecting keeps theirs.
 */
export const syncConflictItem = z.object({
  table: z.string(),
  rowId: z.string(),
  label: z.string(),
  reason: z.string(),
  mine: z.record(z.string(), z.unknown()),
  theirs: z.record(z.string(), z.unknown()),
  ops: z.array(
    z.object({
      op: z.string(),
      table: z.string(),
      id: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
      previous: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  deviceId: z.string(),
  byUser: z.string(),
});
export type SyncConflictItem = z.infer<typeof syncConflictItem>;

/**
 * A cancellation or a revision of an issued document (or a cancelled payment) that the organisation's
 * approval policy holds for an approver (prompt 42). The server keeps the whole transaction; approving
 * applies it there as the person who asked, declining closes it. Decided through the cloud API only.
 */
export const approvalRequestItem = z.object({
  table: z.string(),
  rowId: z.string(),
  module: z.string(),
  change: z.enum(['cancel', 'revise']),
  label: z.string(),
  reason: z.string(),
  theirs: z.record(z.string(), z.unknown()),
  ops: syncConflictItem.shape.ops,
  deviceId: z.string(),
  txId: z.number(),
  byUser: z.string(),
});
export type ApprovalRequestItem = z.infer<typeof approvalRequestItem>;

/** A recurring invoice that could not be made on its day (prompt 44): what failed, and the invoice it copies. */
export const recurringFailedItem = z.object({
  recurringId: z.string(),
  name: z.string(),
  date: z.string(),
  message: z.string(),
  documentId: z.string(),
});
export type RecurringFailedItem = z.infer<typeof recurringFailedItem>;

/**
 * A gateway payment or refund that needs a person (prompt 45): money that matches no invoice, an invoice paid in
 * part, more paid than was owed (kept as credit), or a refund the gateway refused.
 */
export const paymentAttentionItem = z.object({
  reason: z.enum(['unmatched', 'partial', 'overpaid', 'refund_failed']),
  amountPaise: z.number(),
  providerPaymentId: z.string(),
  documentId: z.string().nullable(),
  number: z.string().nullable(),
  message: z.string(),
});
export type PaymentAttentionItem = z.infer<typeof paymentAttentionItem>;

/**
 * Something the GST filing through the GSP needs a person for (prompt 46): the portal login ran out, a return
 * has problems to fix first, the portal refused some invoices, or a return was filed on the portal.
 */
export const filingAttentionItem = z.object({
  /** Return period, MMYYYY. */
  period: z.string(),
  form: z.string(),
  reason: z.enum(['otp', 'blocked', 'push_partial', 'push_failed', 'pull_failed', 'filed']),
  message: z.string(),
});
export type FilingAttentionItem = z.infer<typeof filingAttentionItem>;

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
  ai_extraction: aiExtractionItem,
  prefiling_issue: prefilingIssueItem,
  gsp_job_stopped: gspJobStoppedItem,
  reconciliation_mismatch: genericItem,
  sync_conflict: syncConflictItem,
  approval_request: approvalRequestItem,
  recurring_failed: recurringFailedItem,
  payment_attention: paymentAttentionItem,
  filing_attention: filingAttentionItem,
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
  opens: 'party' | 'item' | 'document' | 'settings' | 'gst' | 'none';
}

export const KIND_INFO: Record<InboxKind, KindInfo> = {
  ai_extraction: {
    label: 'Scanned purchase bill',
    informational: false,
    bulk: false,
    opens: 'document',
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
  prefiling_issue: { label: 'Filing check', informational: true, bulk: false, opens: 'gst' },
  gsp_job_stopped: {
    label: 'Portal request stopped',
    informational: true,
    bulk: false,
    opens: 'document',
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
    opens: 'document',
  },
  approval_request: {
    label: 'Waiting for approval',
    informational: false,
    bulk: false,
    opens: 'document',
  },
  recurring_failed: {
    label: 'Recurring invoice failed',
    informational: true,
    bulk: false,
    opens: 'document',
  },
  filing_attention: {
    label: 'GST filing',
    informational: true,
    bulk: false,
    opens: 'gst',
  },
  payment_attention: {
    label: 'Payment to check',
    informational: true,
    bulk: false,
    opens: 'document',
  },
  reminder_due: { label: 'Payment reminder', informational: false, bulk: false, opens: 'party' },
  low_stock: { label: 'Low stock', informational: true, bulk: false, opens: 'item' },
  draft_stale: { label: 'Old draft', informational: true, bulk: false, opens: 'document' },
  backup_failed: { label: 'Backup failed', informational: true, bulk: false, opens: 'settings' },
  rate_change: { label: 'GST rate changed', informational: false, bulk: true, opens: 'item' },
};

/** A suggestion at or above this confidence (percent) can be bulk-accepted. */
export const BULK_MIN_CONFIDENCE = 90;
