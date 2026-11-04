/**
 * The layout engine: a `PrintModel` and a `TemplateSpec` in, positioned boxes out. There is one
 * engine and two renderers (an SVG preview and the PDF writer) that draw exactly what it returns, so the
 * preview and the PDF cannot disagree. All lengths are points; y grows downwards from the page top.
 *
 * Pagination rules (FR-061): a table row is never split; the closing block (tax summary, totals, bank,
 * terms, signature) moves whole to the next page when it does not fit; later pages carry a
 * "continued" strip and the repeated table header; every page says "Page x of y".
 */
import { amountToWordsEn, amountToWordsHi } from '@gst/domain';
import { printLabel, type PrintLabelKey, type PrintLanguage } from '@gst/i18n';

import type { TextMeasurer, Weight } from './fonts';
import type { PrintModel, PrintLine, TaxSummaryRow } from './model';
import {
  PAGE_SIZES,
  blockApplies,
  blocksIn,
  type BlockSpec,
  type ColumnKey,
  type TemplateSpec,
} from './spec';

export type Align = 'left' | 'center' | 'right';

export type Item =
  | {
      t: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      sw?: number;
    }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number }
  | {
      t: 'text';
      /** Where the text starts (alignment is already applied). */
      x: number;
      /** Top of the line box. */
      y: number;
      text: string;
      size: number;
      weight: Weight;
      color: string;
      /** Degrees anticlockwise, about the centre of the text (watermarks). */
      rotate?: number;
      opacity?: number;
    }
  | { t: 'qr'; x: number; y: number; size: number; data: string }
  | { t: 'image'; x: number; y: number; w: number; h: number; dataUrl: string };

export interface LayoutPage {
  width: number;
  height: number;
  /** Which Rule 48 copy this page belongs to (0 when there is one copy). */
  copy: number;
  items: Item[];
}

export interface LayoutResult {
  pages: LayoutPage[];
  /** Page counts per copy, for "page x of y". */
  pagesPerCopy: number[];
}

export interface LayoutOptions {
  /** Draw the DRAFT watermark even when the status says otherwise (previewing a draft). */
  measurer: TextMeasurer;
  /** Pages of this copy only: 0, 1 or 2 for the three Rule 48 labels. Defaults to the template's choice. */
  copyOnly?: 0 | 1 | 2;
}

const LH = 1.32; // line height as a multiple of the font size
const PAD = 3; // cell padding

const WORDS: Record<PrintLanguage, (p: bigint) => string> = {
  en: amountToWordsEn,
  hi: amountToWordsHi,
  // other languages print the amount in words in English until their own words exist
  ta: amountToWordsEn,
  bn: amountToWordsEn,
  gu: amountToWordsEn,
  mr: amountToWordsHi,
};

/** Greedy word wrap by measured width; a word wider than the box is broken by character. */
export function wrapText(
  text: string,
  weight: Weight,
  size: number,
  maxW: number,
  m: TextMeasurer,
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (m.width(trial, weight, size) <= maxW) {
        line = trial;
        continue;
      }
      if (line) out.push(line);
      if (m.width(word, weight, size) <= maxW) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (m.width(chunk + ch, weight, size) > maxW && chunk) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length === 0 ? [''] : out;
}

interface ColumnLayout {
  key: ColumnKey | 'cgst' | 'sgst' | 'utgst' | 'igst' | 'cess';
  label: PrintLabelKey;
  x: number;
  w: number;
  align: Align;
}

type Cells = Record<ColumnLayout['key'], string>;

const cellsOf = (l: PrintLine): Cells => ({
  sno: l.no,
  item: l.description,
  hsn: l.hsn,
  qty: l.unit ? `${l.qty} ${l.unit}` : l.qty,
  rate: l.rate,
  discount: l.discount,
  taxable: l.taxable,
  taxRate: l.taxRate,
  tax: l.tax,
  amount: l.amount,
  cgst: l.cgst,
  sgst: l.sgst,
  utgst: l.utgst,
  igst: l.igst,
  cess: l.cess,
});

const RIGHT: ReadonlySet<string> = new Set([
  'qty',
  'rate',
  'discount',
  'taxable',
  'taxRate',
  'tax',
  'amount',
  'cgst',
  'sgst',
  'utgst',
  'igst',
  'cess',
]);

const LABEL_OF: Record<ColumnLayout['key'], PrintLabelKey> = {
  sno: 'sno',
  item: 'item',
  hsn: 'hsn',
  qty: 'qty',
  rate: 'rate',
  discount: 'discount',
  taxable: 'taxable',
  taxRate: 'taxRate',
  tax: 'tax',
  amount: 'amount',
  cgst: 'cgst',
  sgst: 'sgst',
  utgst: 'utgst',
  igst: 'igst',
  cess: 'cess',
};

/** The columns this document prints: the template's choice, narrowed by the kind of supply. */
export function columnsFor(spec: TemplateSpec, model: PrintModel, width: number): ColumnLayout[] {
  const taxless = model.supply === 'none';
  const heads = (['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const).filter((h) => model.heads[h]);
  const wanted: { key: ColumnLayout['key']; weight: number }[] = [];
  for (const c of spec.table.columns) {
    if (!c.visible) continue;
    if (c.key === 'discount' && model.lines.every((l) => l.discount === '')) continue;
    if (taxless && (c.key === 'taxable' || c.key === 'taxRate' || c.key === 'tax')) continue;
    if (c.key === 'tax') {
      if (spec.table.taxColumns === 'hidden' || heads.length === 0) continue;
      if (spec.table.taxColumns === 'combined') wanted.push({ key: 'tax', weight: c.weight });
      else for (const h of heads) wanted.push({ key: h, weight: c.weight / heads.length });
      continue;
    }
    if (c.key === 'taxRate' && heads.length === 0) continue;
    wanted.push({ key: c.key, weight: c.weight });
  }
  const total = wanted.reduce((n, c) => n + c.weight, 0);
  let x = 0;
  return wanted.map((c) => {
    const w = (c.weight / total) * width;
    const col: ColumnLayout = {
      key: c.key,
      label: LABEL_OF[c.key],
      x,
      w,
      align: RIGHT.has(c.key) ? 'right' : 'left',
    };
    x += w;
    return col;
  });
}

/** Everything a block needs while it draws. */
interface Ctx {
  spec: TemplateSpec;
  model: PrintModel;
  m: TextMeasurer;
  lang: PrintLanguage;
  size: number;
  /** Content box of the page. */
  left: number;
  width: number;
  label: (k: PrintLabelKey) => string;
}

/** A drawing surface for one block: relative coordinates, a running height, collected items. */
class Sheet {
  items: Item[] = [];
  y = 0;
  constructor(
    private readonly c: Ctx,
    readonly x0: number,
    readonly w: number,
  ) {}

  text(
    text: string,
    opts: {
      x?: number;
      w?: number;
      size?: number;
      weight?: Weight;
      color?: string;
      align?: Align;
      wrap?: boolean;
    } = {},
  ): number {
    const size = opts.size ?? this.c.size;
    const weight = opts.weight ?? 'regular';
    const color = opts.color ?? this.c.spec.theme.text;
    const boxX = this.x0 + (opts.x ?? 0);
    const boxW = opts.w ?? this.w - (opts.x ?? 0);
    const lines = opts.wrap === false ? [text] : wrapText(text, weight, size, boxW, this.c.m);
    for (const line of lines) {
      const width = this.c.m.width(line, weight, size);
      const align = opts.align ?? 'left';
      const x =
        align === 'left'
          ? boxX
          : align === 'right'
            ? boxX + boxW - width
            : boxX + (boxW - width) / 2;
      if (line) this.items.push({ t: 'text', x, y: this.y, text: line, size, weight, color });
      this.y += size * LH;
    }
    return lines.length;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    o: { fill?: string; stroke?: string; sw?: number } = {},
  ) {
    this.items.push({ t: 'rect', x: this.x0 + x, y, w, h, ...o });
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: string, sw = 0.5) {
    this.items.push({ t: 'line', x1: this.x0 + x1, y1, x2: this.x0 + x2, y2, stroke, sw });
  }

  gap(h: number) {
    this.y += h;
  }
}

type Draw = (s: Sheet) => void;

/* ------------------------------------------------------------------ the blocks */

function headerBlock(c: Ctx): Draw {
  const { model, spec } = c;
  const b = model.business;
  return (s) => {
    const name = b.name;
    const big = c.size * 1.7;
    const center = spec.style.headerLayout === 'center';
    const logoH = b.logo ? Math.min(46, (b.logo.height / b.logo.width) * 90) : 0;
    const logoW = b.logo ? (logoH * b.logo.width) / b.logo.height : 0;
    if (b.logo) {
      const lx = center ? (s.w - logoW) / 2 : 0;
      s.items.push({
        t: 'image',
        x: lx + s.x0,
        y: s.y,
        w: logoW,
        h: logoH,
        dataUrl: b.logo.dataUrl,
      });
      if (center) s.gap(logoH + 3);
    }
    const x = center || !b.logo ? 0 : logoW + 8;
    const start = s.y;
    s.text(name, {
      x,
      size: big,
      weight: 'bold',
      color: spec.theme.accent,
      align: center ? 'center' : 'left',
      w: s.w - x,
    });
    if (b.logo && !center) s.y = Math.max(s.y, start + logoH);
    s.gap(2);
  };
}

function businessBlock(c: Ctx): Draw {
  const { model } = c;
  const b = model.business;
  return (s) => {
    const center = c.spec.style.headerLayout === 'center';
    const align: Align = center ? 'center' : 'left';
    const muted = c.spec.theme.muted;
    for (const a of b.address) s.text(a, { color: muted, align });
    const ids: string[] = [];
    if (b.gstin) ids.push(`${c.label('gstin')}: ${b.gstin}`);
    if (b.pan) ids.push(`${c.label('pan')}: ${b.pan}`);
    if (ids.length) s.text(ids.join('   '), { align, weight: 'bold' });
    const contact: string[] = [];
    if (b.phone) contact.push(`${c.label('phone')}: ${b.phone}`);
    if (b.email) contact.push(`${c.label('email')}: ${b.email}`);
    if (contact.length) s.text(contact.join('   '), { color: muted, align });
    s.gap(4);
  };
}

function titleBlock(c: Ctx): Draw {
  const { model, spec } = c;
  return (s) => {
    const title = c.label(`title.${model.type}` as PrintLabelKey);
    const size = c.size * spec.font.titleScale;
    const band = spec.style.titleBand;
    if (band) {
      const h = size * LH + 6;
      s.rect(0, s.y, s.w, h, { fill: spec.theme.accent });
      s.y += 3;
      s.text(title, { size, weight: 'bold', color: '#ffffff', align: 'center' });
      s.y += 3;
    } else {
      s.text(title, { size, weight: 'bold', color: spec.theme.accent, align: 'center' });
    }
    s.gap(3);

    // meta: number and dates on the left, supply and references on the right
    const left: [string, string][] = [];
    if (model.number) left.push([c.label('invoiceNo'), model.number]);
    left.push([c.label('date'), model.date]);
    if (model.dueDate) left.push([c.label('dueDate'), model.dueDate]);
    const right: [string, string][] = [];
    if (model.placeOfSupply) right.push([c.label('placeOfSupply'), model.placeOfSupply]);
    for (const r of model.refs)
      right.push([
        c.label(r.key === 'po' ? 'refPo' : r.key === 'challan' ? 'refChallan' : 'supplierInvoice'),
        r.value,
      ]);
    if (model.reverseCharge) right.push([c.label('reverseCharge'), c.label('reverseChargeYes')]);
    const top = s.y;
    const half = s.w / 2 - 6;
    let lh = 0;
    for (const [k, v] of left) {
      const before = s.y;
      s.text(`${k}: `, { w: half, wrap: false, color: spec.theme.muted });
      s.y = before;
      const kw = c.m.width(`${k}: `, 'regular', c.size);
      s.text(v, { x: kw, w: half - kw, weight: 'bold' });
    }
    lh = s.y - top;
    s.y = top;
    for (const [k, v] of right) {
      const before = s.y;
      s.text(`${k}: `, { x: half + 12, w: half, wrap: false, color: spec.theme.muted });
      s.y = before;
      const kw = c.m.width(`${k}: `, 'regular', c.size);
      s.text(v, { x: half + 12 + kw, w: half - kw, weight: 'bold' });
    }
    s.y = top + Math.max(lh, s.y - top);
    s.gap(4);
  };
}

function partyBlock(c: Ctx): Draw {
  const { model, spec } = c;
  return (s) => {
    const p = model.party;
    const top = s.y;
    const hasShip = !!model.shipTo;
    const colW = hasShip ? s.w / 2 - 6 : s.w;
    const box = (x: number, heading: string, lines: string[], bold: string) => {
      const sh = new Sheet(c, 0, colW);
      sh.y = top + 3;
      sh.text(heading, {
        x: 4,
        w: colW - 8,
        size: c.size * 0.9,
        weight: 'bold',
        color: spec.theme.muted,
      });
      sh.text(bold, { x: 4, w: colW - 8, weight: 'bold', size: c.size * 1.1 });
      for (const l of lines) sh.text(l, { x: 4, w: colW - 8 });
      sh.y += 3;
      return { sh, x };
    };
    const lines = (q: NonNullable<typeof p>): string[] => {
      const out = [...q.address];
      if (q.stateName) out.push(q.stateName);
      if (q.gstin) out.push(`${c.label('gstin')}: ${q.gstin}`);
      if (q.phone) out.push(`${c.label('phone')}: ${q.phone}`);
      return out;
    };
    const bill = box(
      0,
      c.label(model.type.startsWith('purchase') ? 'supplierInvoice' : 'billTo'),
      p ? lines(p) : [],
      p?.name ?? '',
    );
    const ship = hasShip
      ? box(colW + 12, c.label('shipTo'), model.shipTo!.slice(1), model.shipTo![0] ?? '')
      : null;
    const h = Math.max(bill.sh.y, ship?.sh.y ?? 0) - top;
    for (const it of bill.sh.items) s.items.push(shift(it, s, bill.x));
    if (ship) for (const it of ship.sh.items) s.items.push(shift(it, s, ship.x));
    const boxed = spec.style.grid !== 'none';
    if (boxed) {
      s.rect(0, top, colW, h, { stroke: spec.theme.border, sw: 0.6 });
      if (hasShip) s.rect(colW + 12, top, colW, h, { stroke: spec.theme.border, sw: 0.6 });
    }
    s.y = top + h + 6;
  };
}

/** Move a sheet-local item by the block's own x offset. */
function shift(it: Item, s: Sheet, dx: number): Item {
  const x0 = s.x0 + dx;
  switch (it.t) {
    case 'line':
      return { ...it, x1: it.x1 + x0, x2: it.x2 + x0 };
    case 'qr':
    case 'text':
    case 'rect':
    case 'image':
      return { ...it, x: it.x + x0 };
  }
}

/* The table is drawn row by row by the page loop, which knows where pages end. */

function rowHeight(c: Ctx, cols: ColumnLayout[], cells: Cells, noteLine: string | null): number {
  let lines = 1;
  for (const col of cols) {
    const text = cells[col.key];
    if (!text) continue;
    const n =
      col.align === 'right' ? 1 : wrapText(text, 'regular', c.size, col.w - PAD * 2, c.m).length;
    lines = Math.max(lines, n);
  }
  let h = lines * c.size * LH;
  if (noteLine)
    h +=
      wrapText(
        noteLine,
        'regular',
        c.size * 0.9,
        (cols.find((k) => k.key === 'item')?.w ?? 100) - PAD * 2,
        c.m,
      ).length *
      c.size *
      0.9 *
      LH;
  return h + PAD * 2;
}

function drawHeaderRow(
  c: Ctx,
  cols: ColumnLayout[],
  x0: number,
  y: number,
): { items: Item[]; h: number } {
  const { spec } = c;
  const size = c.size * 0.95;
  let lines = 1;
  const labels = cols.map((col) => {
    const t = c.label(col.label);
    const wrapped = wrapText(t, 'bold', size, col.w - PAD * 2, c.m);
    lines = Math.max(lines, wrapped.length);
    return wrapped;
  });
  const h = lines * size * LH + PAD * 2;
  const items: Item[] = [
    { t: 'rect', x: x0, y, w: cols.reduce((n, k) => n + k.w, 0), h, fill: spec.theme.headerFill },
  ];
  cols.forEach((col, i) => {
    labels[i]!.forEach((line, n) => {
      const w = c.m.width(line, 'bold', size);
      const x = col.align === 'right' ? x0 + col.x + col.w - PAD - w : x0 + col.x + PAD;
      items.push({
        t: 'text',
        x,
        y: y + PAD + n * size * LH,
        text: line,
        size,
        weight: 'bold',
        color: spec.theme.headerText,
      });
    });
  });
  return { items, h };
}

function drawRow(
  c: Ctx,
  cols: ColumnLayout[],
  x0: number,
  y: number,
  line: PrintLine,
  index: number,
): { items: Item[]; h: number } {
  const { spec } = c;
  const cells = cellsOf(line);
  const h = rowHeight(c, cols, cells, line.note);
  const items: Item[] = [];
  if (spec.style.zebra && index % 2 === 1)
    items.push({ t: 'rect', x: x0, y, w: cols.reduce((n, k) => n + k.w, 0), h, fill: '#f4f6f8' });
  for (const col of cols) {
    const text = cells[col.key];
    if (!text) continue;
    const parts =
      col.align === 'right' ? [text] : wrapText(text, 'regular', c.size, col.w - PAD * 2, c.m);
    const bold = col.key === 'amount';
    parts.forEach((part, n) => {
      const w = c.m.width(part, bold ? 'bold' : 'regular', c.size);
      const x = col.align === 'right' ? x0 + col.x + col.w - PAD - w : x0 + col.x + PAD;
      items.push({
        t: 'text',
        x,
        y: y + PAD + n * c.size * LH,
        text: part,
        size: c.size,
        weight: bold ? 'bold' : 'regular',
        color: spec.theme.text,
      });
    });
    if (col.key === 'item' && line.note) {
      const notes = wrapText(line.note, 'regular', c.size * 0.9, col.w - PAD * 2, c.m);
      const base = y + PAD + parts.length * c.size * LH;
      notes.forEach((nl, n) =>
        items.push({
          t: 'text',
          x: x0 + col.x + PAD,
          y: base + n * c.size * 0.9 * LH,
          text: nl,
          size: c.size * 0.9,
          weight: 'regular',
          color: spec.theme.muted,
        }),
      );
    }
  }
  // grid
  const total = cols.reduce((n, k) => n + k.w, 0);
  if (spec.style.grid !== 'none')
    items.push({
      t: 'line',
      x1: x0,
      y1: y + h,
      x2: x0 + total,
      y2: y + h,
      stroke: spec.theme.border,
      sw: 0.4,
    });
  if (spec.style.grid === 'box')
    for (const col of cols.slice(1))
      items.push({
        t: 'line',
        x1: x0 + col.x,
        y1: y,
        x2: x0 + col.x,
        y2: y + h,
        stroke: spec.theme.border,
        sw: 0.4,
      });
  return { items, h };
}

/* ------------------------------------------------------------------ closing blocks */

function summaryBlock(c: Ctx): Draw | null {
  const { model } = c;
  if (model.taxSummary.length === 0 || model.supply === 'none') return null;
  const heads = (['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const).filter((h) => model.heads[h]);
  if (heads.length === 0) return null;
  return (s) => {
    s.text(c.label('taxSummary'), {
      weight: 'bold',
      size: c.size * 1.05,
      color: c.spec.theme.accent,
    });
    s.gap(1);
    const cols: { key: keyof TaxSummaryRow; label: PrintLabelKey; w: number; align: Align }[] = [
      { key: 'hsn', label: 'hsn', w: 3, align: 'left' },
      { key: 'rate', label: 'taxRate', w: 1.6, align: 'right' },
      { key: 'taxable', label: 'taxable', w: 3, align: 'right' },
      ...heads.map((h) => ({
        key: h as keyof TaxSummaryRow,
        label: h as PrintLabelKey,
        w: 2.4,
        align: 'right' as Align,
      })),
      { key: 'tax', label: 'tax', w: 2.6, align: 'right' },
    ];
    const total = cols.reduce((n, k) => n + k.w, 0);
    let x = 0;
    const laid = cols.map((k) => {
      const w = (k.w / total) * s.w;
      const r = { ...k, x, w };
      x += w;
      return r;
    });
    const size = c.size * 0.92;
    const hh = size * LH + 4;
    s.rect(0, s.y, s.w, hh, { fill: c.spec.theme.headerFill });
    for (const k of laid) {
      const t = c.label(k.label);
      const w = c.m.width(t, 'bold', size);
      s.items.push({
        t: 'text',
        x: shiftX(s, k.align === 'right' ? k.x + k.w - PAD - w : k.x + PAD),
        y: s.y + 2,
        text: t,
        size,
        weight: 'bold',
        color: c.spec.theme.headerText,
      });
    }
    s.y += hh;
    for (const row of model.taxSummary) {
      for (const k of laid) {
        const t = String(row[k.key]);
        const w = c.m.width(t, 'regular', size);
        s.items.push({
          t: 'text',
          x: shiftX(s, k.align === 'right' ? k.x + k.w - PAD - w : k.x + PAD),
          y: s.y + 2,
          text: t,
          size,
          weight: 'regular',
          color: c.spec.theme.text,
        });
      }
      s.y += hh;
      s.line(0, s.y, s.w, s.y, c.spec.theme.border, 0.3);
    }
    s.gap(4);
  };
}

const shiftX = (s: Sheet, x: number): number => s.x0 + x;

function totalsBlock(c: Ctx): Draw {
  const { model, spec } = c;
  return (s) => {
    const top = s.y;
    const half = s.w * 0.46;
    // left: amount in words, the declaration, the foreign-currency note
    const left = new Sheet(c, 0, s.w - half - 10);
    left.y = top;
    left.text(c.label('amountInWords'), { size: c.size * 0.9, color: spec.theme.muted });
    left.text(WORDS[c.lang](model.totals.totalPaise), { weight: 'bold' });
    if (model.foreign)
      left.text(`${c.label('inForeign')}: ${model.foreign.currency} ${model.foreign.amount}`, {
        color: spec.theme.muted,
      });
    if (model.declaration) {
      left.gap(2);
      left.text(model.declaration, { size: c.size * 0.9, color: spec.theme.muted });
    }
    if (model.supply === 'export' && !model.heads.igst)
      left.text(c.label('exportLut'), { size: c.size * 0.9, color: spec.theme.muted });
    if (model.supply === 'export' && model.heads.igst)
      left.text(c.label('exportIgst'), { size: c.size * 0.9, color: spec.theme.muted });

    // right: the totals
    const right = new Sheet(c, s.w - half, half);
    right.y = top;
    const row = (k: string, v: string, bold = false, big = false) => {
      const size = c.size * (big ? 1.25 : 1);
      const weight: Weight = bold ? 'bold' : 'regular';
      const before = right.y;
      right.text(k, {
        w: half,
        weight,
        size,
        wrap: false,
        color: bold ? spec.theme.text : spec.theme.muted,
      });
      right.y = before;
      right.text(v, { w: half, weight, size, align: 'right', wrap: false });
    };
    const t = model.totals;
    // a document that charges no tax has nothing to separate the total from
    if (model.supply !== 'none') row(c.label('taxable'), t.taxable);
    if (t.discount) row(c.label('discount'), `-${t.discount}`);
    if (t.cgst) row(c.label('cgst'), t.cgst);
    if (t.sgst) row(c.label('sgst'), t.sgst);
    if (t.utgst) row(c.label('utgst'), t.utgst);
    if (t.igst) row(c.label('igst'), t.igst);
    if (t.cess) row(c.label('cess'), t.cess);
    if (t.tcs) row(c.label('tcs'), t.tcs);
    if (t.roundOff) row(c.label('roundOff'), t.roundOff);
    right.line(0, right.y, half, right.y, spec.theme.border, 0.6);
    right.gap(1);
    row(c.label('total'), t.total, true, true);

    for (const it of left.items) s.items.push(it);
    for (const it of right.items) s.items.push(it);
    s.y = Math.max(left.y, right.y) + 6;
  };
}

function bankBlock(c: Ctx): Draw | null {
  const { model, spec } = c;
  if (model.accounts.length === 0) return null;
  return (s) => {
    const top = s.y;
    const qrSize = model.upi ? 64 : 0;
    const textW = s.w - (qrSize ? qrSize + 12 : 0);
    const left = new Sheet(c, 0, textW);
    left.y = top;
    left.text(c.label('bank'), { weight: 'bold', size: c.size * 1.05, color: spec.theme.accent });
    for (const a of model.accounts) {
      if (a.kind === 'bank') {
        left.text(a.name + (a.holder ? ` - ${a.holder}` : ''), { weight: 'bold' });
        const parts = [
          a.accountNo ? `${c.label('accountNo')} ${a.accountNo}` : '',
          a.ifsc ? `${c.label('ifsc')} ${a.ifsc}` : '',
        ].filter(Boolean);
        if (parts.length) left.text(parts.join('   '));
      } else if (a.upiId) left.text(`${c.label('upi')}: ${a.upiId}`);
    }
    for (const it of left.items) s.items.push(it);
    let h = left.y - top;
    if (model.upi) {
      const x = shiftX(s, s.w - qrSize);
      s.items.push({ t: 'qr', x, y: top, size: qrSize, data: model.upi.payload });
      s.items.push({
        t: 'text',
        x: x + (qrSize - c.m.width(c.label('scanToPay'), 'regular', c.size * 0.8)) / 2,
        y: top + qrSize + 1,
        text: c.label('scanToPay'),
        size: c.size * 0.8,
        weight: 'regular',
        color: spec.theme.muted,
      });
      h = Math.max(h, qrSize + c.size * 0.8 * LH + 1);
    }
    s.y = top + h + 6;
  };
}

function textBlock(c: Ctx, label: PrintLabelKey, lines: string[]): Draw | null {
  if (lines.length === 0) return null;
  return (s) => {
    s.text(c.label(label), { weight: 'bold', size: c.size * 1.0, color: c.spec.theme.accent });
    for (const l of lines) s.text(l, { size: c.size * 0.92, color: c.spec.theme.muted });
    s.gap(4);
  };
}

function einvoiceBlock(c: Ctx): Draw | null {
  const e = c.model.einvoice;
  if (!e) return null;
  return (s) => {
    const top = s.y;
    const qr = e.signedQr ? 70 : 0;
    const w = s.w - (qr ? qr + 12 : 0);
    const left = new Sheet(c, 0, w);
    left.y = top;
    left.text(`${c.label('irn')}: ${e.irn}`, { size: c.size * 0.85 });
    if (e.ackNo)
      left.text(
        `${c.label('ackNo')}: ${e.ackNo}${e.ackDate ? `   ${c.label('ackDate')}: ${e.ackDate}` : ''}`,
        { size: c.size * 0.85 },
      );
    if (c.model.eway) left.text(`${c.label('ewayBill')}: ${c.model.eway}`, { size: c.size * 0.85 });
    for (const it of left.items) s.items.push(it);
    let h = left.y - top;
    if (e.signedQr) {
      s.items.push({ t: 'qr', x: shiftX(s, s.w - qr), y: top, size: qr, data: e.signedQr });
      h = Math.max(h, qr);
    }
    s.y = top + h + 6;
  };
}

function signatureBlock(c: Ctx): Draw {
  return (s) => {
    s.gap(4);
    const w = s.w * 0.4;
    const x = s.w - w;
    s.text(`${c.label('forCompany')} ${c.model.business.name}`, {
      x,
      w,
      weight: 'bold',
      align: 'center',
    });
    s.gap(c.size * 3);
    s.line(x, s.y, s.w, s.y, c.spec.theme.border, 0.5);
    s.text(c.label('authorisedSignatory'), {
      x,
      w,
      size: c.size * 0.9,
      color: c.spec.theme.muted,
      align: 'center',
    });
    s.gap(2);
  };
}

/* ------------------------------------------------------------------ the page loop */

const COPY_KEYS: PrintLabelKey[] = ['copy.original', 'copy.duplicate', 'copy.triplicate'];

function watermarkWords(
  model: PrintModel,
  spec: TemplateSpec,
  c: Ctx,
): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  if (model.status === 'cancelled' && spec.watermark.cancelled)
    out.push({ text: c.label('watermark.cancelled'), color: '#cc2222' });
  if (model.status === 'draft' && spec.watermark.draft)
    out.push({ text: c.label('watermark.draft'), color: '#888888' });
  if (spec.watermark.custom) out.push({ text: spec.watermark.custom, color: '#888888' });
  return out;
}

/** Lay out one copy of the document across as many pages as it needs. */
function layoutCopy(
  model: PrintModel,
  spec: TemplateSpec,
  m: TextMeasurer,
  copy: number,
): LayoutPage[] {
  const lang = spec.language;
  const label = (k: PrintLabelKey) => printLabel(lang, k, spec.labels as never);
  const size = spec.font.size;
  const pageDef = PAGE_SIZES[spec.page.size];
  const mg = spec.page.margin;
  const left = mg.left;
  const width = pageDef.width - mg.left - mg.right;
  const c: Ctx = { spec, model, m, lang, size, left, width, label };
  const footerH = size * LH * 1.6;
  const bottom = pageDef.height - mg.bottom - footerH;
  const doc = { type: model.type, supply: model.supply };

  const pages: LayoutPage[] = [];
  let page!: LayoutPage;
  let y = 0;

  const chrome = (continued: boolean) => {
    page = { width: pageDef.width, height: pageDef.height, copy, items: [] };
    pages.push(page);
    y = mg.top;
    const copyLabel = spec.copies === 'rule48' ? label(COPY_KEYS[copy]!) : null;
    if (copyLabel) {
      const w = m.width(copyLabel, 'bold', size * 0.85);
      page.items.push({
        t: 'text',
        x: left + width - w,
        y: Math.max(4, mg.top - size * 1.5),
        text: copyLabel,
        size: size * 0.85,
        weight: 'bold',
        color: spec.theme.muted,
      });
    }
    for (const wm of watermarkWords(model, spec, c)) {
      const big = Math.min(pageDef.width * 0.16, 90);
      const w = m.width(wm.text, 'bold', big);
      page.items.push({
        t: 'text',
        x: (pageDef.width - w) / 2,
        y: pageDef.height / 2 - big / 2,
        text: wm.text,
        size: big,
        weight: 'bold',
        color: wm.color,
        rotate: 35,
        opacity: 0.14,
      });
    }
    if (continued) {
      const t = `${label(`title.${model.type}` as PrintLabelKey)} ${model.number ?? ''}`.trim();
      page.items.push({
        t: 'text',
        x: left,
        y,
        text: t,
        size,
        weight: 'bold',
        color: spec.theme.accent,
      });
      const cw = m.width(label('continued'), 'regular', size);
      page.items.push({
        t: 'text',
        x: left + width - cw,
        y,
        text: label('continued'),
        size,
        weight: 'regular',
        color: spec.theme.muted,
      });
      y += size * LH;
      page.items.push({
        t: 'line',
        x1: left,
        y1: y,
        x2: left + width,
        y2: y,
        stroke: spec.theme.border,
        sw: 0.6,
      });
      y += 4;
    }
  };

  /** Draw a block into the current page at `y`. */
  const place = (draw: Draw) => {
    const s = new Sheet(c, left, width);
    s.y = y;
    draw(s);
    page.items.push(...s.items);
    y = s.y;
  };
  /** The height a block needs, found by drawing it on a scratch sheet. */
  const measure = (draw: Draw): number => {
    const s = new Sheet(c, left, width);
    s.y = 0;
    draw(s);
    return s.y;
  };

  chrome(false);

  const topDraw: Partial<Record<BlockSpec['type'], Draw>> = {
    header: headerBlock(c),
    business: businessBlock(c),
    title: titleBlock(c),
    party: partyBlock(c),
  };
  for (const b of blocksIn(spec, 'top')) if (blockApplies(b, doc)) place(topDraw[b.type]!);

  // the table
  const tableOn = spec.blocks.some((b) => b.type === 'lines' && blockApplies(b, doc));
  const cols = columnsFor(spec, model, width);
  const tableWidth = width;
  let tableTop = y;
  const startTable = () => {
    const hr = drawHeaderRow(c, cols, left, y);
    page.items.push(...hr.items);
    y += hr.h;
  };
  if (tableOn) {
    startTable();
    tableTop = y - 0;
    model.lines.forEach((line, i) => {
      const cells = cellsOf(line);
      const h = rowHeight(c, cols, cells, line.note);
      if (y + h > bottom) {
        if (spec.style.grid === 'box') closeBox();
        chrome(true);
        startTable();
        tableTop = y;
      }
      const r = drawRow(c, cols, left, y, line, i);
      page.items.push(...r.items);
      y += r.h;
    });
    if (spec.style.grid === 'box') closeBox();
  }
  function closeBox() {
    // the outer frame of the table on this page, from its header to the last row
    const top = tableTop;
    page.items.push({
      t: 'rect',
      x: left,
      y: top,
      w: tableWidth,
      h: y - top,
      stroke: spec.theme.border,
      sw: 0.6,
    });
  }
  y += 6;

  // the closing group: one unit, moved whole to the next page when it does not fit
  const closing: Draw[] = [];
  const sum = summaryBlock(c);
  const byType: Partial<Record<BlockSpec['type'], Draw | null>> = {
    taxSummary: sum,
    totals: totalsBlock(c),
    einvoice: einvoiceBlock(c),
    bank: bankBlock(c),
    terms: textBlock(c, 'terms', model.terms),
    notes: textBlock(c, 'notes', model.notes),
    signature: signatureBlock(c),
  };
  for (const b of blocksIn(spec, 'closing')) {
    if (!blockApplies(b, doc)) continue;
    const d = byType[b.type];
    if (d) closing.push(d);
  }
  const unit: Draw = (s) => closing.forEach((d) => d(s));
  const unitH = measure(unit);
  const room = bottom - y;
  if (unitH <= room) place(unit);
  else {
    const fresh = bottom - (mg.top + size * LH + 4);
    if (unitH <= fresh) {
      chrome(true);
      place(unit);
    } else {
      // too big for one page even alone: keep each block whole instead
      for (const d of closing) {
        const h = measure(d);
        if (y + h > bottom) chrome(true);
        place(d);
      }
    }
  }

  // every page says where it is
  const footerText = spec.blocks.find((b) => b.type === 'footer');
  const showFooter = footerText && blockApplies(footerText, doc);
  pages.forEach((p, n) => {
    const fy = pageDef.height - mg.bottom - size * LH;
    p.items.push({
      t: 'line',
      x1: left,
      y1: fy - 3,
      x2: left + width,
      y2: fy - 3,
      stroke: spec.theme.border,
      sw: 0.4,
    });
    const pg = `${label('page')} ${n + 1} ${label('pageOf')} ${pages.length}`;
    const w = m.width(pg, 'regular', size * 0.85);
    p.items.push({
      t: 'text',
      x: left + width - w,
      y: fy,
      text: pg,
      size: size * 0.85,
      weight: 'regular',
      color: spec.theme.muted,
    });
    if (showFooter && footerText!.text) {
      p.items.push({
        t: 'text',
        x: left,
        y: fy,
        text: footerText!.text,
        size: size * 0.85,
        weight: 'regular',
        color: spec.theme.muted,
      });
    }
  });
  return pages;
}

/** Lay out the document: one copy, or the three Rule 48 copies, each labelled. */
export function layoutDocument(
  model: PrintModel,
  spec: TemplateSpec,
  opts: LayoutOptions,
): LayoutResult {
  const copies =
    spec.copies === 'rule48' ? (opts.copyOnly !== undefined ? [opts.copyOnly] : [0, 1, 2]) : [0];
  const pages: LayoutPage[] = [];
  const pagesPerCopy: number[] = [];
  for (const copy of copies) {
    const p = layoutCopy(model, spec, opts.measurer, copy);
    pagesPerCopy.push(p.length);
    pages.push(...p);
  }
  return { pages, pagesPerCopy };
}
