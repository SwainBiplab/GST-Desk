/**
 * The template spec: a JSON description of how a document prints. The same spec drives the live
 * preview, the PDF and the designer, so what you design is what you print. It is plain data (no
 * functions), validated on import, and small enough to store in `templates.config_json`.
 *
 * Lengths are in points (1/72 inch) so a spec means the same thing at any zoom.
 */
import { DOCUMENT_TYPES, type DocumentType } from '@gst/domain';
import { PRINT_LANGUAGES, type PrintLabelKey, type PrintLanguage } from '@gst/i18n';
import { z } from 'zod';

export const PAGE_SIZES = {
  a4: { name: 'A4', width: 595.28, height: 841.89 },
  a5: { name: 'A5', width: 419.53, height: 595.28 },
  letter: { name: 'Letter', width: 612, height: 792 },
} as const;
export type PageSize = keyof typeof PAGE_SIZES;

/** Where each block sits in the page; the designer reorders blocks within a zone. */
export const BLOCK_ZONES = {
  header: 'top',
  business: 'top',
  title: 'top',
  party: 'top',
  lines: 'table',
  taxSummary: 'closing',
  totals: 'closing',
  bank: 'closing',
  terms: 'closing',
  notes: 'closing',
  signature: 'closing',
  einvoice: 'closing',
  footer: 'pageFooter',
} as const;
export type BlockType = keyof typeof BLOCK_ZONES;
export type Zone = (typeof BLOCK_ZONES)[BlockType];
export const BLOCK_TYPES = Object.keys(BLOCK_ZONES) as BlockType[];

export const COLUMN_KEYS = [
  'sno',
  'item',
  'hsn',
  'qty',
  'rate',
  'discount',
  'taxable',
  'taxRate',
  'tax',
  'amount',
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const SUPPLY_KINDS = ['intra', 'inter', 'export', 'none'] as const;
export type SupplyKind = (typeof SUPPLY_KINDS)[number];

/** Every kind of document that prints (the domain's list, plus the reverse-charge self-invoice). */
export const PRINT_DOC_TYPES = [
  ...DOCUMENT_TYPES,
  'rcm_self_invoice',
] as const satisfies readonly DocumentType[];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1a3c6e');
const pt = z.number().min(0).max(200);

const blockSchema = z.object({
  type: z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]),
  visible: z.boolean(),
  /** Show only for these document types (empty or absent: all). */
  onlyTypes: z.array(z.enum(PRINT_DOC_TYPES)).optional(),
  /** Show only for these kinds of supply. */
  onlySupply: z.array(z.enum(SUPPLY_KINDS)).optional(),
  /** Free text where the block takes some (the footer line). */
  text: z.string().max(300).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const columnSchema = z.object({
  key: z.enum(COLUMN_KEYS),
  visible: z.boolean(),
  /** Relative width; the table shares the page width in these proportions. */
  weight: z.number().min(0.3).max(60),
});

const labelOverrides = z.record(z.string(), z.record(z.string(), z.string().max(80)));

export const templateSpecSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(80),
  basedOn: z.string().nullable(),
  page: z.object({
    size: z.enum(['a4', 'a5', 'letter']),
    margin: z.object({ top: pt, right: pt, bottom: pt, left: pt }),
  }),
  language: z.enum(PRINT_LANGUAGES),
  theme: z.object({
    accent: hex,
    text: hex,
    muted: hex,
    border: hex,
    /** Fill behind the table header (and the title band, in styles that have one). */
    headerFill: hex,
    headerText: hex,
  }),
  font: z.object({
    /** Body text size in points. Everything else scales from it. */
    size: z.number().min(6).max(14),
    /** Scale of the document title against body text. */
    titleScale: z.number().min(1).max(3),
  }),
  style: z.object({
    titleBand: z.boolean(),
    grid: z.enum(['lines', 'box', 'none']),
    zebra: z.boolean(),
    /** Logo and business name side by side, or stacked in the centre. */
    headerLayout: z.enum(['left', 'center']),
  }),
  blocks: z.array(blockSchema).min(1),
  table: z.object({
    columns: z.array(columnSchema).min(2),
    /** Per-head columns for the supply (CGST and SGST, or IGST), one combined column, or none. */
    taxColumns: z.enum(['split', 'combined', 'hidden']),
  }),
  copies: z.enum(['single', 'rule48']),
  watermark: z.object({
    /** A custom word printed across every page (DRAFT and CANCELLED are automatic). */
    custom: z.string().max(30).nullable(),
    draft: z.boolean(),
    cancelled: z.boolean(),
  }),
  labels: labelOverrides,
  thermal: z.object({
    widthMm: z.union([z.literal(58), z.literal(80)]),
    showBusiness: z.boolean(),
    showTaxSummary: z.boolean(),
    footer: z.string().max(120),
  }),
});

export type TemplateSpec = z.infer<typeof templateSpecSchema>;
export type BlockSpec = TemplateSpec['blocks'][number];
export type ColumnSpec = TemplateSpec['table']['columns'][number];

export type LabelOverrides = Partial<Record<PrintLanguage, Partial<Record<PrintLabelKey, string>>>>;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

/** Parse and check template JSON (an import, or a stored template). Returns the spec or says what is wrong. */
export function parseTemplate(input: unknown): TemplateSpec {
  const text = typeof input === 'string' ? input : null;
  let value: unknown = input;
  if (text !== null) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new TemplateError('That is not a template file: it is not valid JSON.');
    }
  }
  const r = templateSpecSchema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0]!;
    throw new TemplateError(
      `The template is not valid at ${first.path.join('.') || 'the top'}: ${first.message}.`,
    );
  }
  const spec = r.data;
  // one block of each type at most, and every column once
  const seen = new Set<string>();
  for (const b of spec.blocks) {
    if (seen.has(b.type)) throw new TemplateError(`The template has two "${b.type}" blocks.`);
    seen.add(b.type);
  }
  const cols = new Set<string>();
  for (const c of spec.table.columns) {
    if (cols.has(c.key)) throw new TemplateError(`The template has two "${c.key}" columns.`);
    cols.add(c.key);
  }
  if (!spec.table.columns.some((c) => c.key === 'item' && c.visible))
    throw new TemplateError('The description column cannot be hidden.');
  if (!spec.table.columns.some((c) => c.key === 'amount' && c.visible))
    throw new TemplateError('The amount column cannot be hidden.');
  return spec;
}

/** The template as a file: stable key order, readable, importable on another machine. */
export const exportTemplate = (spec: TemplateSpec): string => JSON.stringify(spec, null, 2);

export const zoneOf = (type: BlockType): Zone => BLOCK_ZONES[type];

/** Blocks of one zone, in the template's order, that are switched on. */
export const blocksIn = (spec: TemplateSpec, zone: Zone): BlockSpec[] =>
  spec.blocks.filter((b) => zoneOf(b.type) === zone && b.visible);

export interface AppliesTo {
  type: DocumentType;
  supply: SupplyKind;
}

/** Does a block show for this document? (Its own switch, then its type and supply rules.) */
export function blockApplies(b: BlockSpec, doc: AppliesTo): boolean {
  if (!b.visible) return false;
  if (b.onlyTypes && b.onlyTypes.length > 0 && !b.onlyTypes.includes(doc.type)) return false;
  if (b.onlySupply && b.onlySupply.length > 0 && !b.onlySupply.includes(doc.supply)) return false;
  return true;
}

/** Move a block within its zone, one step up or down. Blocks never leave their zone. */
export function moveBlock(spec: TemplateSpec, type: BlockType, by: -1 | 1): TemplateSpec {
  const zone = zoneOf(type);
  const idx = spec.blocks.map((b, i) => (zoneOf(b.type) === zone ? i : -1)).filter((i) => i >= 0);
  const at = idx.findIndex((i) => spec.blocks[i]!.type === type);
  const to = at + by;
  if (at < 0 || to < 0 || to >= idx.length) return spec;
  const blocks = [...spec.blocks];
  const a = idx[at]!;
  const b = idx[to]!;
  [blocks[a], blocks[b]] = [blocks[b]!, blocks[a]!];
  return { ...spec, blocks };
}

/** Switch a block on or off. */
export const toggleBlock = (
  spec: TemplateSpec,
  type: BlockType,
  visible: boolean,
): TemplateSpec => ({
  ...spec,
  blocks: spec.blocks.map((b) => (b.type === type ? { ...b, visible } : b)),
});

/** Switch a column on or off. The description and amount columns always stay. */
export const toggleColumn = (
  spec: TemplateSpec,
  key: ColumnKey,
  visible: boolean,
): TemplateSpec => ({
  ...spec,
  table: {
    ...spec.table,
    columns: spec.table.columns.map((c) =>
      c.key === key && key !== 'item' && key !== 'amount' ? { ...c, visible } : c,
    ),
  },
});

/** Character width of a thermal roll: 32 columns at 58 mm, 48 at 80 mm (Font A, 12 dots per character). */
export const thermalColumns = (widthMm: 58 | 80): number => (widthMm === 58 ? 32 : 48);
