/**
 * The five templates every business starts with. A preset is only a `TemplateSpec`: nothing about it is
 * special-cased in layout, so a business can copy one and change anything.
 */
import type { BlockSpec, ColumnSpec, TemplateSpec } from './spec';

export const PRESET_IDS = ['classic', 'modern', 'compact', 'tally', 'retail'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const block = (type: BlockSpec['type'], over: Partial<BlockSpec> = {}): BlockSpec => ({
  type,
  visible: true,
  ...over,
});

const col = (key: ColumnSpec['key'], weight: number, visible = true): ColumnSpec => ({
  key,
  visible,
  weight,
});

const BLOCKS: BlockSpec[] = [
  block('header'),
  block('business'),
  block('title'),
  block('party'),
  block('lines'),
  // a bill of supply (and a composition business) charges no tax, so there is no tax to summarise
  block('taxSummary', {
    onlyTypes: [
      'tax_invoice',
      'credit_note',
      'debit_note',
      'purchase_bill',
      'purchase_return',
      'rcm_self_invoice',
      'proforma',
      'quotation',
    ],
  }),
  block('totals'),
  block('einvoice'),
  block('bank'),
  block('terms'),
  block('notes'),
  block('signature'),
  block('footer', { text: '' }),
];

const COLUMNS: ColumnSpec[] = [
  col('sno', 3),
  col('item', 22),
  col('hsn', 7),
  col('qty', 6),
  col('rate', 8),
  col('discount', 6, false),
  col('taxable', 9),
  col('taxRate', 5),
  col('tax', 14),
  col('amount', 10),
];

const base: TemplateSpec = {
  v: 1,
  name: 'Classic',
  basedOn: 'classic',
  page: { size: 'a4', margin: { top: 32, right: 32, bottom: 40, left: 32 } },
  language: 'en',
  theme: {
    accent: '#1a3c6e',
    text: '#111111',
    muted: '#555555',
    border: '#9aa3ad',
    headerFill: '#e8edf3',
    headerText: '#111111',
  },
  font: { size: 9, titleScale: 1.6 },
  style: { titleBand: false, grid: 'lines', zebra: false, headerLayout: 'left' },
  blocks: BLOCKS,
  table: { columns: COLUMNS, taxColumns: 'split' },
  copies: 'single',
  watermark: { custom: null, draft: true, cancelled: true },
  labels: {},
  thermal: {
    widthMm: 80,
    showBusiness: true,
    showTaxSummary: false,
    footer: 'Thank you. Visit again.',
  },
};

const clone = (s: TemplateSpec): TemplateSpec => JSON.parse(JSON.stringify(s)) as TemplateSpec;

function make(id: PresetId, name: string, edit: (s: TemplateSpec) => void): TemplateSpec {
  const s = clone(base);
  s.name = name;
  s.basedOn = id;
  edit(s);
  return s;
}

export const PRESETS: Record<PresetId, TemplateSpec> = {
  classic: make('classic', 'Classic', () => undefined),

  modern: make('modern', 'Modern', (s) => {
    s.theme.accent = '#0f766e';
    s.theme.headerFill = '#0f766e';
    s.theme.headerText = '#ffffff';
    s.theme.border = '#cbd5d1';
    s.font = { size: 9.5, titleScale: 2.1 };
    s.style = { titleBand: true, grid: 'none', zebra: true, headerLayout: 'left' };
  }),

  compact: make('compact', 'Compact', (s) => {
    s.page.margin = { top: 22, right: 22, bottom: 28, left: 22 };
    s.font = { size: 8, titleScale: 1.4 };
    s.table.taxColumns = 'combined';
    s.theme.headerFill = '#eeeeee';
    s.theme.accent = '#222222';
  }),

  tally: make('tally', 'Tally-like', (s) => {
    s.theme = {
      accent: '#000000',
      text: '#000000',
      muted: '#333333',
      border: '#000000',
      headerFill: '#ffffff',
      headerText: '#000000',
    };
    s.font = { size: 8.5, titleScale: 1.3 };
    s.style = { titleBand: false, grid: 'box', zebra: false, headerLayout: 'center' };
    s.copies = 'rule48';
  }),

  retail: make('retail', 'Retail', (s) => {
    s.page = { size: 'a5', margin: { top: 24, right: 24, bottom: 30, left: 24 } };
    s.font = { size: 9, titleScale: 1.5 };
    s.table.columns = s.table.columns.map((c) =>
      c.key === 'hsn' || c.key === 'taxRate' ? { ...c, visible: false } : c,
    );
    s.table.taxColumns = 'combined';
    s.blocks = s.blocks.map((b) => (b.type === 'taxSummary' ? { ...b, visible: false } : b));
    s.theme.accent = '#7c2d12';
    s.theme.headerFill = '#fdf2e9';
    s.thermal.widthMm = 58;
  }),
};

export const presetList = (): TemplateSpec[] => PRESET_IDS.map((id) => clone(PRESETS[id]));

/** A fresh copy of a preset (specs are edited by copy, never in place). */
export const presetSpec = (id: PresetId): TemplateSpec => clone(PRESETS[id]);
