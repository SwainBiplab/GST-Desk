/** Zod schemas shared by UI forms and the API. Money is integer paise (bigint). */
import { z } from 'zod';

import { checkGstin, PAN } from '../gstin';
import { isValidStateCode } from '../tax/supply';

export const DOCUMENT_TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'receipt_voucher',
  'purchase_bill',
  'purchase_return',
  'expense',
] as const;

/** Integer paise from a number, numeric string or bigint. */
export const paiseSchema = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v) => BigInt(v));

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => checkGstin(v).valid, 'not a valid GSTIN');

export const panSchema = z.string().trim().toUpperCase().regex(PAN, 'not a valid PAN');

export const stateCodeSchema = z.string().refine(isValidStateCode, 'unknown state code');

const basisPoints = z.number().int().min(0).max(10_000);

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().optional(),
  pincode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  stateCode: stateCodeSchema,
});

export const businessInputSchema = z.object({
  legalName: z.string().min(1),
  tradeName: z.string().optional(),
  gstin: gstinSchema.optional(),
  pan: panSchema.optional(),
  stateCode: stateCodeSchema,
  scheme: z.enum(['regular', 'composition']).default('regular'),
  fyStartMonth: z.number().int().min(1).max(12).default(4),
  address: addressSchema.optional(),
});

export const partyInputSchema = z
  .object({
    type: z.enum(['customer', 'supplier', 'both']),
    name: z.string().min(1),
    gstin: gstinSchema.optional(),
    pan: panSchema.optional(),
    stateCode: stateCodeSchema.optional(),
    creditDays: z.number().int().min(0).default(0),
    isSez: z.boolean().default(false),
    isExport: z.boolean().default(false),
    isUnregistered: z.boolean().default(false),
    isComposition: z.boolean().default(false),
  })
  .refine((p) => !(p.isUnregistered && p.gstin), {
    message: 'an unregistered party cannot have a GSTIN',
    path: ['gstin'],
  });

export const itemInputSchema = z.object({
  kind: z.enum(['goods', 'service']).default('goods'),
  name: z.string().min(1),
  hsn: z
    .string()
    .regex(/^\d{4}(\d{2}(\d{2})?)?$/, 'HSN/SAC must be 4, 6 or 8 digits')
    .optional(),
  unit: z.string().min(1).optional(),
  saleRatePaise: paiseSchema.default(0n),
  gstRateBp: basisPoints.default(0),
  cessBp: basisPoints.default(0),
  taxability: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst']).default('taxable'),
});

export const discountSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('percent'), bp: basisPoints }),
  z.object({ mode: z.literal('per_unit'), perUnitPaise: paiseSchema }),
  z.object({ mode: z.literal('price_includes_tax') }),
]);

export const lineInputSchema = z.object({
  itemId: z.string().optional(),
  description: z.string().optional(),
  hsn: z.string().optional(),
  qtyMicros: paiseSchema.refine((q) => q > 0n, 'quantity must be positive'),
  ratePaise: paiseSchema,
  discount: discountSchema.default({ mode: 'none' }),
  pricing: z.enum(['exclusive', 'inclusive']).default('exclusive'),
  gstRateBp: basisPoints,
  cessBp: basisPoints.default(0),
  cessPerUnitPaise: paiseSchema.default(0n),
  taxability: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst']).default('taxable'),
});

export const documentInputSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    date: isoDate,
    dueDate: isoDate.optional(),
    partyId: z.string().optional(),
    placeOfSupply: stateCodeSchema,
    reverseCharge: z.boolean().default(false),
    invoiceDiscount: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('percent'), bp: basisPoints }),
        z.object({ mode: z.literal('amount'), paise: paiseSchema }),
      ])
      .optional(),
    roundOff: z.enum(['none', 'nearest_rupee']).default('nearest_rupee'),
    notes: z.string().optional(),
    lines: z.array(lineInputSchema).min(1, 'add at least one line'),
  })
  .refine((d) => !d.dueDate || d.dueDate >= d.date, {
    message: 'due date cannot be before the document date',
    path: ['dueDate'],
  });

export type BusinessInput = z.infer<typeof businessInputSchema>;
export type PartyInput = z.infer<typeof partyInputSchema>;
export type ItemInput = z.infer<typeof itemInputSchema>;
export type LineInputData = z.infer<typeof lineInputSchema>;
export type DocumentInput = z.infer<typeof documentInputSchema>;

/* Placeholders: filled in by the Phase 2 prompts (30, 32). Accept anything object-shaped for now. */
export const gstr1Schema = z.object({}).passthrough();
export const gstr3bSchema = z.object({}).passthrough();
export const eInvoiceV11Schema = z.object({}).passthrough();
export const eWayBillSchema = z.object({}).passthrough();
