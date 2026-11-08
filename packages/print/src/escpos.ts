/**
 * Thermal receipts. One composer turns a print model into lines that fit the roll (32 characters at
 * 58 mm, 48 at 80 mm); the lines become ESC/POS bytes for a printer, or monospaced text for the
 * browser's print dialog, so the receipt looks the same either way.
 *
 * ESC/POS printers have no Indian-script fonts, so a line in Hindi, Tamil and so on is sent as a bitmap
 * the caller draws (a canvas in the browser); without one the receipt prints in English.
 */
import { printLabel, type PrintLabelKey, type PrintLanguage } from '@gst/i18n';

import { formatInr, type PrintModel } from './model';
import { thermalColumns, type TemplateSpec } from './spec';

export interface ReceiptLine {
  text: string;
  align: 'left' | 'center' | 'right';
  bold?: boolean;
  /** 2 prints double width and height. */
  size?: 1 | 2;
  /** A line of dashes across the roll (text is ignored). */
  rule?: boolean;
  /** A QR code (data in `text`). */
  qr?: boolean;
}

/** A 1-bit image for the printer: rows of bytes, most significant bit first, 1 = black. */
export interface Raster {
  widthBytes: number;
  height: number;
  data: Uint8Array;
}

export type Rasterizer = (text: string, opts: { bold: boolean; widthPx: number }) => Raster;

/* ------------------------------------------------------------------ the text composer */

/** Characters a Latin thermal printer can print as they are. */
export const isPrintable = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** `left` and `right` on one line of `cols`, the left text shortened if they would collide. */
export function twoColumns(left: string, right: string, cols: number): string {
  const room = cols - right.length - 1;
  const l = clip(left, Math.max(0, room));
  return l + ' '.repeat(Math.max(1, cols - l.length - right.length)) + right;
}

/** Break text into lines of at most `cols` characters on spaces (a longer word is cut). */
export function wrapCols(text: string, cols: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > cols) {
      if (line) {
        out.push(line);
        line = '';
      }
      out.push(w.slice(0, cols));
      w = w.slice(cols);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= cols) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

export interface ReceiptOptions {
  /** Label language; Latin-only printers get English unless a rasterizer is given. */
  language?: PrintLanguage;
  /** Print the invoice QR (GSTIN, number, date, total) so a return can scan the bill (prompt 52). */
  billQr?: boolean;
}

/** Compose the receipt as lines that fit the roll. */
export function receiptLines(
  model: PrintModel,
  spec: TemplateSpec,
  opts: ReceiptOptions = {},
): ReceiptLine[] {
  const cols = thermalColumns(spec.thermal.widthMm);
  const lang = opts.language ?? 'en';
  const L = (k: PrintLabelKey) => printLabel(lang, k, spec.labels as never);
  const out: ReceiptLine[] = [];
  const add = (text: string, o: Partial<ReceiptLine> = {}) =>
    out.push({ text, align: 'left', ...o });
  const wrapped = (text: string, o: Partial<ReceiptLine> = {}) =>
    wrapCols(text, cols).forEach((t) => add(t, o));
  const rule = () => out.push({ text: '', align: 'left', rule: true });
  const money = (s: string) => s;

  if (spec.thermal.showBusiness) {
    for (const t of wrapCols(model.business.name, cols / 2))
      add(t, { align: 'center', bold: true, size: 2 });
    for (const a of model.business.address) wrapped(a, { align: 'center' });
    if (model.business.gstin) add(`${L('gstin')}: ${model.business.gstin}`, { align: 'center' });
    if (model.business.phone) add(`${L('phone')}: ${model.business.phone}`, { align: 'center' });
  }
  rule();
  add(L(`title.${model.type}` as PrintLabelKey), { align: 'center', bold: true });
  add(twoColumns(model.number ? `${L('invoiceNo')} ${model.number}` : '', model.date, cols));
  if (model.party) wrapped(model.party.name, { bold: true });
  rule();

  for (const l of model.lines) {
    wrapped(l.description);
    const left = `${l.qty}${l.unit ? ` ${l.unit}` : ''} x ${l.rate}`;
    add(twoColumns(left, money(l.amount), cols));
  }
  rule();

  const t = model.totals;
  if (model.supply !== 'none') add(twoColumns(L('taxable'), t.taxable, cols));
  if (t.discount) add(twoColumns(L('discount'), `-${t.discount}`, cols));
  for (const [k, v] of [
    ['cgst', t.cgst],
    ['sgst', t.sgst],
    ['utgst', t.utgst],
    ['igst', t.igst],
    ['cess', t.cess],
    ['tcs', t.tcs],
    ['roundOff', t.roundOff],
  ] as [PrintLabelKey, string | null][])
    if (v) add(twoColumns(L(k), v, cols));
  rule();
  // "Rs" instead of the rupee sign: most thermal code pages do not have one
  const totalValue = `Rs ${formatInr(t.totalPaise)}`;
  const half = Math.floor(cols / 2);
  // double-size characters take two columns each: use them only when label and amount still fit
  if (L('total').length + 1 + totalValue.length <= half)
    add(twoColumns(L('total'), totalValue, half), { bold: true, size: 2, align: 'left' });
  else add(twoColumns(L('total'), totalValue, cols), { bold: true });

  if (spec.thermal.showTaxSummary && model.taxSummary.length > 0 && model.supply !== 'none') {
    rule();
    add(L('taxSummary'), { bold: true });
    for (const r of model.taxSummary)
      add(twoColumns(`${r.hsn} ${r.rate}`, `${r.taxable} ${r.tax}`, cols));
  }
  if (model.declaration) wrapped(model.declaration);
  if (model.upi) {
    add('', {});
    out.push({ text: model.upi.payload, align: 'center', qr: true });
    add(L('scanToPay'), { align: 'center' });
  }
  if (opts.billQr && model.qr) {
    add('');
    out.push({ text: model.qr, align: 'center', qr: true });
  }
  if (spec.thermal.footer) {
    add('');
    wrapped(spec.thermal.footer, { align: 'center' });
  }
  if (model.status === 'cancelled') {
    add('');
    add(L('watermark.cancelled'), { align: 'center', bold: true, size: 2 });
  }
  return out;
}

/** The lines as plain monospaced text with alignment applied (the browser's print dialog, and a preview). */
export function receiptText(lines: readonly ReceiptLine[], cols: number): string {
  return lines
    .map((l) => {
      if (l.rule) return '-'.repeat(cols);
      if (l.qr) return '[ QR ]'.padStart(Math.floor((cols + 6) / 2));
      const w = l.size === 2 ? Math.floor(cols / 2) : cols;
      const text = clip(l.text, w);
      if (l.align === 'center') return ' '.repeat(Math.floor((w - text.length) / 2)) + text;
      if (l.align === 'right') return ' '.repeat(w - text.length) + text;
      return text;
    })
    .join('\n');
}

/** HTML for the browser's print dialog at the roll's width. */
export function receiptHtml(model: PrintModel, spec: TemplateSpec): string {
  const cols = thermalColumns(spec.thermal.widthMm);
  const text = receiptText(receiptLines(model, spec), cols)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre style="width:${spec.thermal.widthMm}mm;margin:0;font:12px/1.25 monospace;white-space:pre">${text}</pre>`;
}

/* ------------------------------------------------------------------ the bytes */

const ESC = 0x1b;
const GS = 0x1d;

export const CMD = {
  init: [ESC, 0x40],
  codepage437: [ESC, 0x74, 0x00],
  left: [ESC, 0x61, 0],
  center: [ESC, 0x61, 1],
  right: [ESC, 0x61, 2],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  size1: [GS, 0x21, 0x00],
  size2: [GS, 0x21, 0x11],
  lf: [0x0a],
  /** Partial cut after feeding. */
  cut: [GS, 0x56, 0x42, 0x00],
  /** Kick the cash drawer on pin 2: 25 x 2 ms on, 250 x 2 ms off. */
  drawer: [ESC, 0x70, 0x00, 0x19, 0xfa],
} as const;

export const feed = (n: number): number[] => [ESC, 0x64, Math.min(255, Math.max(0, n))];

/** Native QR: model 2, module size, error level M, the data, then print. */
export function qrCommand(data: string, moduleSize = 6): number[] {
  const bytes = [...new TextEncoder().encode(data)];
  const n = bytes.length + 3;
  return [
    GS,
    0x28,
    0x6b,
    0x04,
    0x00,
    0x31,
    0x41,
    0x32,
    0x00,
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x43,
    moduleSize,
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x45,
    0x31,
    GS,
    0x28,
    0x6b,
    n % 256,
    Math.floor(n / 256),
    0x31,
    0x50,
    0x30,
    ...bytes,
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x51,
    0x30,
  ];
}

/** GS v 0: print a raster image. */
export function rasterCommand(r: Raster): number[] {
  return [
    GS,
    0x76,
    0x30,
    0x00,
    r.widthBytes % 256,
    Math.floor(r.widthBytes / 256),
    r.height % 256,
    Math.floor(r.height / 256),
    ...r.data,
  ];
}

/** A few Latin-1 letters that CP437 has; anything else the printer cannot print becomes `?`. */
const CP437: Record<string, number> = {
  Ç: 0x80,
  ü: 0x81,
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  ç: 0x87,
  ê: 0x88,
  ë: 0x89,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  Ä: 0x8e,
  É: 0x90,
  ô: 0x93,
  ö: 0x94,
  ò: 0x95,
  û: 0x96,
  ù: 0x97,
  Ö: 0x99,
  Ü: 0x9a,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
  '£': 0x9c,
  '°': 0xf8,
};

export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else out.push(CP437[ch] ?? 0x3f);
  }
  return out;
}

export interface ReceiptBytesOptions {
  /** Draw a line in a script the printer has no font for. */
  rasterize?: Rasterizer;
  /** Kick the cash drawer after printing. */
  cashDrawer?: boolean;
  /** Blank lines after the receipt, before the cut. */
  feedLines?: number;
  /** Print the invoice QR so a return can scan the bill (prompt 52). */
  billQr?: boolean;
}

/** The receipt as ESC/POS bytes. */
export function receiptBytes(
  model: PrintModel,
  spec: TemplateSpec,
  opts: ReceiptBytesOptions = {},
): Uint8Array {
  const cols = thermalColumns(spec.thermal.widthMm);
  // without a way to draw other scripts, a receipt is printed in English
  const language: PrintLanguage = opts.rasterize ? spec.language : 'en';
  const lines = receiptLines(model, spec, { language, ...(opts.billQr ? { billQr: true } : {}) });
  const out: number[] = [...CMD.init, ...CMD.codepage437];
  const widthPx = cols * 12;
  for (const l of lines) {
    if (l.rule) {
      out.push(...CMD.left, ...encodeText('-'.repeat(cols)), ...CMD.lf);
      continue;
    }
    out.push(...(l.align === 'center' ? CMD.center : l.align === 'right' ? CMD.right : CMD.left));
    if (l.qr) {
      out.push(...qrCommand(l.text), ...CMD.lf);
      continue;
    }
    // a script the printer has no font for (Latin, Latin-1 and the rupee sign it can print or replace)
    const otherScript = [...l.text].some((ch) => ch.codePointAt(0)! > 0x24f && ch !== '₹');
    if (otherScript && opts.rasterize) {
      out.push(...rasterCommand(opts.rasterize(l.text, { bold: !!l.bold, widthPx })));
      continue;
    }
    out.push(...(l.bold ? CMD.boldOn : CMD.boldOff), ...(l.size === 2 ? CMD.size2 : CMD.size1));
    out.push(...encodeText(l.text.replace('₹', 'Rs')), ...CMD.lf);
    out.push(...CMD.boldOff, ...CMD.size1);
  }
  out.push(...CMD.left, ...feed(opts.feedLines ?? 4), ...CMD.cut);
  if (opts.cashDrawer) out.push(...CMD.drawer);
  return Uint8Array.from(out);
}
