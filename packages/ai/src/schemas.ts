/** Output schemas for the built-in features. Callers pass these to `router.suggest` / `extract`. */
import { z } from 'zod';

export const hsnSuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      code: z.string(),
      description: z.string(),
      rateBp: z.number().int(),
      cessBp: z.number().int(),
      score: z.number(),
    }),
  ),
});
export type HsnSuggestions = z.infer<typeof hsnSuggestionsSchema>;

export const duplicatePartySchema = z.object({
  matches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      score: z.number().min(0).max(1),
      reasons: z.array(z.enum(['gstin', 'phone', 'name', 'similar_name'])),
    }),
  ),
});
export type DuplicateParties = z.infer<typeof duplicatePartySchema>;

/** Fields a purchase-bill extraction must produce (prompt 21 builds the feature on this). */
export const purchaseBillSchema = z.object({
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
    }),
  ),
  totalPaise: z.number().int(),
});
export type PurchaseBill = z.infer<typeof purchaseBillSchema>;

/** What a spoken sentence becomes before a person confirms it (prompt 36). */
export const voiceDraftSchema = z.object({
  intent: z.enum(['sale', 'purchase', 'payment', 'unknown']),
  party: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      qty: z.number(),
      unit: z.string().nullable(),
      ratePaise: z.number().int().nullable(),
    }),
  ),
  amountPaise: z.number().int().nullable(),
});
export type VoiceDraft = z.infer<typeof voiceDraftSchema>;

/** Registry used by the eval CLI and fixtures. */
export const SCHEMAS = {
  purchaseBill: purchaseBillSchema,
  hsnSuggestion: hsnSuggestionsSchema,
  voiceDraft: voiceDraftSchema,
} as const;
export type SchemaName = keyof typeof SCHEMAS;
