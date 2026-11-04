import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';

import { presetSpec, type TemplateSpec } from '../src';
import { FontMeasurer, type FontBytes } from '../src/fonts';
import { loadFontsNode } from '../src/fonts.node';
import { layoutDocument } from '../src/layout';
import { renderPdf, stampPdf } from '../src/pdf';

import { sampleModel } from './helpers';

let fonts: FontBytes;
let measurer: FontMeasurer;
beforeAll(() => {
  fonts = loadFontsNode(['latin', 'latinExt', 'devanagari', 'tamil', 'bengali', 'gujarati']);
  measurer = new FontMeasurer(fonts);
});

const make = async (
  opts: Parameters<typeof sampleModel>[0] = {},
  spec: TemplateSpec = presetSpec('classic'),
): Promise<Uint8Array> => {
  const r = layoutDocument(sampleModel(opts), spec, { measurer });
  return renderPdf(r.pages, fonts, { title: 'Invoice', created: new Date('2026-05-01T00:00:00Z') });
};

/** Spaces differ between runs drawn in different fonts, so compare without them. */
const squash = (s: string) => s.replace(/\s+/g, '');

/** The text of every page, as a PDF reader would extract it. */
async function extract(bytes: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((x) => ('str' in x ? x.str : '')).join(' '));
  }
  return out;
}

describe('a one-page invoice', () => {
  it('is a valid PDF under 150 KB with embedded subset fonts', async () => {
    const bytes = await make();
    expect(bytes.length).toBeLessThan(150 * 1024);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/FontFile2');
    expect(text).toContain('/ToUnicode');
  });

  it('keeps the text selectable and searchable', async () => {
    const [page] = await extract(await make());
    for (const word of [
      'Tax Invoice',
      'INV/26-27/0001',
      'Sharma Stores',
      'Demo Traders Pvt Ltd',
      'Authorised Signatory',
    ]) {
      expect(squash(page!), word).toContain(squash(word));
    }
    expect(squash(page!)).toContain(squash(sampleModel().totals.total));
    expect(squash(page!)).toContain('27AABCD1234E1Z5');
  });

  it('gives the same bytes for the same document (deterministic)', async () => {
    const a = await make();
    const b = await make();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('has the page size of the template: A4, A5 and Letter', async () => {
    for (const [size, w, h] of [
      ['a4', 595.28, 841.89],
      ['a5', 419.53, 595.28],
      ['letter', 612, 792],
    ] as const) {
      const spec = { ...presetSpec('classic'), page: { ...presetSpec('classic').page, size } };
      const doc = await PDFDocument.load(await make({}, spec));
      const p = doc.getPage(0).getSize();
      expect(p.width).toBeCloseTo(w, 1);
      expect(p.height).toBeCloseTo(h, 1);
    }
  });
});

describe('scripts and languages', () => {
  it('prints Hindi labels and the rupee sign as real text', async () => {
    const spec = { ...presetSpec('classic'), language: 'hi' as const };
    const [page] = await extract(await make({}, spec));
    expect(squash(page!)).toContain(squash('कर चालान'));
    expect(page).toContain('₹');
    expect(squash(page!)).toContain(squash('रुपये'));
  });

  for (const [lang, title] of [
    ['ta', 'வரி விலைப்பட்டியல்'],
    ['bn', 'কর চালান'],
    ['gu', 'ટેક્સ ઇન્વોઇસ'],
    ['mr', 'कर बीजक'],
  ] as const) {
    it(`prints ${lang} in its own script`, async () => {
      const spec = { ...presetSpec('classic'), language: lang };
      const bytes = await make({}, spec);
      expect(bytes.length).toBeLessThan(250 * 1024);
      const [page] = await extract(bytes);
      // shaped Indic text can reorder code points on extraction, so compare the letters without marks
      const letters = (s: string) => s.replace(/[\p{M}\s]/gu, '');
      expect(letters(page!)).toContain(letters(title).slice(0, 3));
    });
  }
});

describe('pagination in the file', () => {
  it('writes one PDF page for each layout page, each saying where it is', async () => {
    const bytes = await make({ lines: 60 });
    const pages = await extract(bytes);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
    expect(pages.slice(1).every((p) => p.includes('continued'))).toBe(true);
  });

  it('three Rule 48 copies are three labelled pages', async () => {
    const pages = await extract(await make({}, presetSpec('tally')));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('Original for Recipient');
    expect(pages[2]).toContain('Triplicate for Supplier');
  });

  it('a long invoice stays small', async () => {
    const bytes = await make({ lines: 200 });
    expect(bytes.length).toBeLessThan(400 * 1024);
  });
});

describe('speed', () => {
  it('lays out and writes a 50-line invoice in well under 2 seconds', async () => {
    const t0 = performance.now();
    await make({ lines: 50 });
    const first = performance.now() - t0;
    const t1 = performance.now();
    await make({ lines: 50 });
    expect(Math.min(first, performance.now() - t1)).toBeLessThan(1500);
  });
});

describe('stamping an existing PDF', () => {
  it('adds CANCELLED to every page and keeps the original text', async () => {
    const original = await make({ lines: 60 });
    const stamped = await stampPdf(original, 'CANCELLED', fonts);
    const pages = await extract(stamped);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p).toContain('CANCELLED');
      expect(p).toContain('Page ');
    }
    expect(pages[0]).toContain('Tax Invoice');
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(pages.length);
  });
});

describe('QR codes and logos', () => {
  it('draws the payment QR as vectors (no image) and a logo as an image', async () => {
    const bytes = Buffer.from(await make()).toString('latin1');
    expect(bytes).not.toContain('/Subtype /Image');
    // a 1x1 PNG logo
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const model = sampleModel();
    model.business.logo = { dataUrl: png, width: 40, height: 40 };
    const r = layoutDocument(model, presetSpec('classic'), { measurer });
    const withLogo = Buffer.from(await renderPdf(r.pages, fonts)).toString('latin1');
    expect(withLogo).toContain('/Subtype /Image');
  });
});
