/**
 * The PDF writer: draws the layout boxes exactly where the engine put them. Fonts are embedded as
 * subsets (only the glyphs used), text stays real text (selectable and searchable), QR codes are vector
 * squares, and the bytes are deterministic: the same document and template give the same file.
 */
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';

import {
  FontMeasurer,
  fontkit,
  splitRuns,
  type FontBytes,
  type FontFamily,
  type Weight,
} from './fonts';
import type { Item, LayoutPage } from './layout';
import { qrMatrix } from './qr';

export interface PdfOptions {
  title?: string;
  author?: string;
  subject?: string;
  /** Fixed into the file so the same input gives the same bytes. */
  created?: Date;
}

const color = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** What the measurer says a font's ascent is, so text sits on the same baseline as in the preview. */
export const baselineOffset = (size: number, ascent: number): number => ascent * size;

class Fonts {
  private readonly cache = new Map<string, PDFFont>();
  constructor(
    private readonly doc: PDFDocument,
    private readonly bytes: FontBytes,
  ) {}

  async get(family: FontFamily, weight: Weight): Promise<PDFFont> {
    const tries: `${FontFamily}:${Weight}`[] = [
      `${family}:${weight}`,
      `${family}:regular`,
      `latin:${weight}`,
      'latin:regular',
    ];
    for (const key of tries) {
      const hit = this.cache.get(key);
      if (hit) return hit;
      const raw = this.bytes[key];
      if (raw) {
        const f = await this.doc.embedFont(raw, { subset: true });
        this.cache.set(key, f);
        return f;
      }
    }
    // no font files at all: a standard font, so the call still produces a (Latin-only) PDF
    const f = await this.doc.embedFont(
      weight === 'bold' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica,
    );
    this.cache.set(`latin:${weight}`, f);
    return f;
  }
}

/** Write the pages as a PDF. */
export async function renderPdf(
  pages: readonly LayoutPage[],
  fontBytes: FontBytes,
  opts: PdfOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const when = opts.created ?? new Date(0);
  doc.setTitle(opts.title ?? 'Document');
  doc.setAuthor(opts.author ?? '');
  doc.setSubject(opts.subject ?? '');
  doc.setCreator('GST Desk');
  doc.setProducer('GST Desk');
  doc.setCreationDate(when);
  doc.setModificationDate(when);

  const fonts = new Fonts(doc, fontBytes);
  const measurer = new FontMeasurer(fontBytes);
  const ascent = measurer.metrics().ascent;
  const images = new Map<string, PDFImage>();

  for (const p of pages) {
    const page = doc.addPage([p.width, p.height]);
    for (const item of p.items)
      await draw(page, p.height, item, fonts, measurer, ascent, images, doc);
  }
  // no object streams: every font and its ToUnicode map stay readable by simple tools
  return doc.save({ useObjectStreams: false });
}

async function draw(
  page: PDFPage,
  H: number,
  it: Item,
  fonts: Fonts,
  measurer: FontMeasurer,
  ascent: number,
  images: Map<string, PDFImage>,
  doc: PDFDocument,
): Promise<void> {
  switch (it.t) {
    case 'rect':
      page.drawRectangle({
        x: it.x,
        y: H - it.y - it.h,
        width: it.w,
        height: it.h,
        ...(it.fill ? { color: color(it.fill) } : {}),
        ...(it.stroke ? { borderColor: color(it.stroke), borderWidth: it.sw ?? 0.5 } : {}),
      });
      return;
    case 'line':
      page.drawLine({
        start: { x: it.x1, y: H - it.y1 },
        end: { x: it.x2, y: H - it.y2 },
        thickness: it.sw,
        color: color(it.stroke),
      });
      return;
    case 'qr': {
      const q = qrMatrix(it.data);
      const quiet = 1;
      const cell = it.size / (q.size + quiet * 2);
      page.drawRectangle({
        x: it.x,
        y: H - it.y - it.size,
        width: it.size,
        height: it.size,
        color: rgb(1, 1, 1),
      });
      for (let r = 0; r < q.size; r++) {
        let c = 0;
        while (c < q.size) {
          if (!q.dark[r * q.size + c]) {
            c++;
            continue;
          }
          let end = c;
          while (end < q.size && q.dark[r * q.size + end]) end++;
          page.drawRectangle({
            x: it.x + (c + quiet) * cell,
            y: H - it.y - (r + quiet + 1) * cell,
            width: (end - c) * cell,
            height: cell,
            color: rgb(0, 0, 0),
          });
          c = end;
        }
      }
      return;
    }
    case 'image': {
      let img = images.get(it.dataUrl);
      if (!img) {
        img = it.dataUrl.startsWith('data:image/png')
          ? await doc.embedPng(it.dataUrl)
          : await doc.embedJpg(it.dataUrl);
        images.set(it.dataUrl, img);
      }
      page.drawImage(img, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
      return;
    }
    case 'text': {
      const baseline = H - it.y - baselineOffset(it.size, ascent);
      const total = measurer.width(it.text, it.weight, it.size);
      // a rotated text turns about its centre
      const theta = ((it.rotate ?? 0) * Math.PI) / 180;
      const cx = it.x + total / 2;
      const cy = baseline + it.size * 0.35;
      let x = it.x;
      let y = baseline;
      if (it.rotate) {
        const vx = -total / 2;
        const vy = -it.size * 0.35;
        x = cx + vx * Math.cos(theta) - vy * Math.sin(theta);
        y = cy + vx * Math.sin(theta) + vy * Math.cos(theta);
      }
      let advance = 0;
      for (const run of splitRuns(it.text)) {
        const font = await fonts.get(run.family, it.weight);
        const rx = x + advance * Math.cos(theta);
        const ry = y + advance * Math.sin(theta);
        page.drawText(run.text, {
          x: rx,
          y: ry,
          size: it.size,
          font,
          color: color(it.color),
          ...(it.opacity !== undefined ? { opacity: it.opacity } : {}),
          ...(it.rotate ? { rotate: degrees(it.rotate) } : {}),
        });
        advance += measurer.width(run.text, it.weight, it.size);
      }
      return;
    }
  }
}

/**
 * Stamp a word (CANCELLED) across every page of an existing PDF, in red at low opacity, keeping the
 * original text selectable underneath. Used when a document is cancelled after its PDF was made.
 */
export async function stampPdf(
  pdf: Uint8Array,
  text: string,
  fontBytes: FontBytes,
  opts: { color?: string; opacity?: number } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new Fonts(doc, fontBytes);
  const measurer = new FontMeasurer(fontBytes);
  const ascent = measurer.metrics().ascent;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.min(width * 0.16, 90);
    const total = measurer.width(text, 'bold', size);
    const theta = (35 * Math.PI) / 180;
    const cx = width / 2;
    const cy = height / 2;
    const vx = -total / 2;
    const vy = -size * 0.35;
    let advance = 0;
    for (const run of splitRuns(text)) {
      const font = await fonts.get(run.family, 'bold');
      page.drawText(run.text, {
        x: cx + vx * Math.cos(theta) - vy * Math.sin(theta) + advance * Math.cos(theta),
        y: cy + vx * Math.sin(theta) + vy * Math.cos(theta) + advance * Math.sin(theta),
        size,
        font,
        color: color(opts.color ?? '#cc2222'),
        opacity: opts.opacity ?? 0.2,
        rotate: degrees(35),
      });
      advance += measurer.width(run.text, 'bold', size);
    }
    void ascent;
  }
  return doc.save({ useObjectStreams: false });
}
