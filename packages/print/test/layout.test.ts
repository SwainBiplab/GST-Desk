import { describe, expect, it } from 'vitest';

import { PAGE_SIZES, PRESET_IDS, PRESETS, presetSpec, type TemplateSpec } from '../src';
import { FixedMeasurer } from '../src/fonts';
import { layoutDocument, wrapText, type Item, type LayoutPage } from '../src/layout';

import { allTexts, sampleModel, textItems, texts } from './helpers';

const m = new FixedMeasurer(0.5);
const lay = (model = sampleModel(), spec: TemplateSpec = presetSpec('classic')) =>
  layoutDocument(model, spec, { measurer: m });

describe('one page', () => {
  const r = lay();

  it('prints the title, the number, the party and the same total the engine computed', () => {
    const t = allTexts(r.pages);
    expect(r.pages).toHaveLength(1);
    expect(t).toContain('Tax Invoice');
    expect(t.some((x) => x.includes('INV/26-27/0001'))).toBe(true);
    expect(t).toContain('Sharma Stores');
    expect(t).toContain(sampleModel().totals.total);
    expect(t).toContain('Page 1 of 1');
    expect(t.some((x) => x.startsWith('Rupees') && x.endsWith('Only'))).toBe(true);
  });

  it('prints the bank block with a UPI QR, the terms as bullets, and the signature', () => {
    const t = allTexts(r.pages);
    expect(t.some((x) => x.includes('50100123456789'))).toBe(true);
    expect(r.pages[0]!.items.some((i) => i.t === 'qr')).toBe(true);
    expect(t).toContain('• Interest at 18% on late payment');
    expect(t).toContain('Authorised Signatory');
  });

  it('keeps every box on the page', () => {
    for (const p of r.pages) inside(p);
  });
});

function inside(p: LayoutPage) {
  for (const i of p.items) {
    const [x1, y1, x2, y2] =
      i.t === 'line'
        ? [i.x1, i.y1, i.x2, i.y2]
        : i.t === 'text'
          ? [i.x, i.y, i.x, i.y]
          : i.t === 'qr'
            ? [i.x, i.y, i.x + i.size, i.y + i.size]
            : [i.x, i.y, i.x + i.w, i.y + i.h];
    expect(Math.min(x1, x2), JSON.stringify(i)).toBeGreaterThanOrEqual(0);
    expect(Math.max(x1, x2), JSON.stringify(i)).toBeLessThanOrEqual(p.width + 0.01);
    expect(Math.min(y1, y2), JSON.stringify(i)).toBeGreaterThanOrEqual(0);
    expect(Math.max(y1, y2), JSON.stringify(i)).toBeLessThanOrEqual(p.height + 0.01);
  }
}

describe('pagination', () => {
  const spec = presetSpec('classic');
  const cases = [1, 25, 60, 200];
  const results = cases.map((n) => ({ n, r: lay(sampleModel({ lines: n }), spec) }));

  it('uses more pages for more lines', () => {
    const pages = results.map((x) => x.r.pages.length);
    expect(pages[0]).toBe(1);
    expect(pages[1]!).toBeGreaterThanOrEqual(1);
    expect(pages[2]!).toBeGreaterThan(pages[1]! - 1);
    expect(pages[3]!).toBeGreaterThan(pages[2]!);
  });

  for (const { n, r } of results) {
    it(`${n} lines: every page repeats the table header, says "continued" after the first, and "Page x of y"`, () => {
      const total = r.pages.length;
      r.pages.forEach((p, i) => {
        const t = texts(p);
        // a page that holds table rows repeats the header; a page that only carries the closing block has no table
        const hasRows = t.some((x) => /^Widget number/.test(x));
        expect(
          t.filter((x) => x === 'Description'),
          `page ${i + 1}`,
        ).toHaveLength(hasRows || i === 0 ? 1 : 0);
        expect(t.includes('continued'), `page ${i + 1}`).toBe(i > 0);
        expect(t).toContain(`Page ${i + 1} of ${total}`);
        inside(p);
      });
    });

    it(`${n} lines: every line is printed once, whole, and above the footer`, () => {
      const model = sampleModel({ lines: n });
      const spec2 = presetSpec('classic');
      const limit = PAGE_SIZES.a4.height - spec2.page.margin.bottom;
      const rows = r.pages.flatMap((p) =>
        textItems(p).filter((x) => /^Widget number \d+ /.test(x.text)),
      );
      // each line's description appears (it may wrap onto more text items, but the first words are unique)
      expect(new Set(rows.map((x) => x.text.match(/^Widget number (\d+)/)![1])).size).toBe(
        model.lines.length,
      );
      for (const row of rows) expect(row.y + row.size).toBeLessThan(limit);
    });

    it(`${n} lines: the totals appear exactly once`, () => {
      expect(allTexts(r.pages).filter((x) => x === 'Total')).toHaveLength(1);
    });
  }

  it('the closing block moves whole: its pieces are never on different pages', () => {
    const pieces = ['Tax Summary', 'Total', 'Authorised Signatory', 'Bank Details'];
    for (let n = 1; n <= 45; n++) {
      const r = lay(sampleModel({ lines: n }), spec);
      const where = pieces.map((p) => r.pages.findIndex((pg) => texts(pg).includes(p)));
      expect(new Set(where).size, `${n} lines: ${where.join(',')}`).toBe(1);
    }
  });

  it('the closing block sits below the last row, never on top of it', () => {
    for (const n of [1, 10, 20, 28, 30, 36]) {
      const r = lay(sampleModel({ lines: n }), spec);
      const last = r.pages[r.pages.length - 1]!;
      const rowYs = textItems(last)
        .filter((x) => /^Widget number/.test(x.text))
        .map((x) => x.y);
      const totalY = textItems(last).find((x) => x.text === 'Total')!.y;
      if (rowYs.length) expect(totalY, `${n} lines`).toBeGreaterThan(Math.max(...rowYs));
    }
  });
});

describe('presets and page sizes', () => {
  for (const id of PRESET_IDS) {
    for (const size of ['a4', 'a5', 'letter'] as const) {
      it(`${id} on ${size}: lays out 30 lines inside the page`, () => {
        const spec = { ...presetSpec(id), page: { ...PRESETS[id].page, size } };
        const r = lay(sampleModel({ lines: 30 }), spec);
        expect(r.pages.length).toBeGreaterThanOrEqual(1);
        for (const p of r.pages) {
          expect(p.width).toBeCloseTo(PAGE_SIZES[size].width, 1);
          inside(p);
        }
        expect(allTexts(r.pages)).toContain(sampleModel({ lines: 30 }).totals.total);
      });
    }
  }

  it('layout boxes are stable (snapshot per preset and page size)', () => {
    const out: Record<string, unknown> = {};
    for (const id of PRESET_IDS)
      for (const size of ['a4', 'a5', 'letter'] as const) {
        const spec = { ...presetSpec(id), page: { ...PRESETS[id].page, size } };
        const r = lay(sampleModel({ lines: 12 }), spec);
        out[`${id}/${size}`] = {
          pages: r.pages.length,
          boxes: r.pages.map((p) => p.items.map(box)),
        };
      }
    expect(out).toMatchSnapshot();
  });
});

const rnd = (n: number) => Math.round(n * 10) / 10;
function box(i: Item): string {
  switch (i.t) {
    case 'text':
      return `T ${rnd(i.x)},${rnd(i.y)} ${i.size} ${i.weight[0]} ${i.text}`;
    case 'rect':
      return `R ${rnd(i.x)},${rnd(i.y)} ${rnd(i.w)}x${rnd(i.h)}`;
    case 'line':
      return `L ${rnd(i.x1)},${rnd(i.y1)}-${rnd(i.x2)},${rnd(i.y2)}`;
    case 'qr':
      return `Q ${rnd(i.x)},${rnd(i.y)} ${rnd(i.size)}`;
    case 'image':
      return `I ${rnd(i.x)},${rnd(i.y)} ${rnd(i.w)}x${rnd(i.h)}`;
  }
}

describe('Rule 48 copies, watermarks and languages', () => {
  it('the Tally-like preset prints three labelled copies', () => {
    const r = lay(sampleModel(), presetSpec('tally'));
    expect(r.pagesPerCopy).toEqual([1, 1, 1]);
    expect(r.pages.map((p) => p.copy)).toEqual([0, 1, 2]);
    expect(texts(r.pages[0]!)).toContain('Original for Recipient');
    expect(texts(r.pages[1]!)).toContain('Duplicate for Transporter');
    expect(texts(r.pages[2]!)).toContain('Triplicate for Supplier');
    // one copy on request
    const one = layoutDocument(sampleModel(), presetSpec('tally'), { measurer: m, copyOnly: 1 });
    expect(one.pages).toHaveLength(1);
    expect(texts(one.pages[0]!)).toContain('Duplicate for Transporter');
    // a single-copy template carries no label
    expect(allTexts(lay().pages)).not.toContain('Original for Recipient');
  });

  it('stamps DRAFT on a draft, CANCELLED on a cancelled document, and a custom word on request', () => {
    const wm = (status: 'draft' | 'issued' | 'cancelled', spec = presetSpec('classic')) =>
      lay(sampleModel({ status }), spec).pages.flatMap((p) => textItems(p).filter((x) => x.rotate));
    expect(wm('draft').map((x) => x.text)).toEqual(['DRAFT']);
    expect(wm('cancelled').map((x) => x.text)).toEqual(['CANCELLED']);
    expect(wm('issued')).toHaveLength(0);
    const custom = {
      ...presetSpec('classic'),
      watermark: { custom: 'DUPLICATE', draft: true, cancelled: true },
    };
    expect(wm('issued', custom).map((x) => x.text)).toEqual(['DUPLICATE']);
    const off = {
      ...presetSpec('classic'),
      watermark: { custom: null, draft: false, cancelled: false },
    };
    expect(wm('cancelled', off)).toHaveLength(0);
    // every page of a long document carries it
    const long = lay(sampleModel({ status: 'cancelled', lines: 60 }), presetSpec('classic'));
    expect(long.pages.every((p) => textItems(p).some((x) => x.text === 'CANCELLED'))).toBe(true);
  });

  it('prints labels in the template language, and amount in words in Hindi', () => {
    const hi = { ...presetSpec('classic'), language: 'hi' as const };
    const t = allTexts(lay(sampleModel(), hi).pages);
    expect(t).toContain('कर चालान');
    expect(t).toContain('कुल');
    expect(t.some((x) => x.endsWith('रुपये मात्र'))).toBe(true);
    expect(t).toContain('पृष्ठ 1 का 1');
  });

  it('uses a label override from the template', () => {
    const spec = { ...presetSpec('classic'), labels: { en: { total: 'Grand Total' } } };
    expect(allTexts(lay(sampleModel(), spec).pages)).toContain('Grand Total');
  });
});

describe('what a document shows depends on what it is', () => {
  const heads = (t: string[]) => ({
    cgst: t.includes('CGST'),
    sgst: t.includes('SGST'),
    igst: t.includes('IGST'),
  });

  it('an intra-state invoice splits tax into CGST and SGST; an inter-state one shows IGST', () => {
    expect(heads(allTexts(lay(sampleModel({ pos: '27' })).pages))).toEqual({
      cgst: true,
      sgst: true,
      igst: false,
    });
    expect(heads(allTexts(lay(sampleModel({ pos: '29' })).pages))).toEqual({
      cgst: false,
      sgst: false,
      igst: true,
    });
  });

  it('a bill of supply, and any composition business, shows no tax and no tax summary', () => {
    for (const model of [
      sampleModel({ type: 'bill_of_supply', gstRateBp: 0 }),
      sampleModel({ composition: true, type: 'bill_of_supply' }),
    ]) {
      const t = allTexts(lay(model).pages);
      expect(heads(t)).toEqual({ cgst: false, sgst: false, igst: false });
      expect(t).not.toContain('Tax Summary');
      expect(t).not.toContain('Taxable');
    }
    const comp = allTexts(lay(sampleModel({ composition: true, type: 'bill_of_supply' })).pages);
    expect(comp.some((x) => x.includes('Composition taxable person'))).toBe(true);
  });

  it('an export under LUT carries the Rule 46 wording and no tax columns', () => {
    const t = allTexts(lay(sampleModel({ export: true, pos: '96' })).pages);
    expect(t.some((x) => x.includes('export under LUT'))).toBe(true);
    expect(heads(t).igst).toBe(false);
  });

  it('reverse charge is stated on the document', () => {
    const t = allTexts(lay(sampleModel({ reverseCharge: true })).pages);
    expect(t).toContain('Tax is payable on reverse charge');
  });

  it('split, combined and hidden tax columns', () => {
    /** The labels in the table header row (the texts on the same line as "Description"). */
    const header = (spec: TemplateSpec) => {
      const p = lay(sampleModel(), spec).pages[0]!;
      const y = textItems(p).find((i) => i.text === 'Description')!.y;
      return textItems(p)
        .filter((i) => Math.abs(i.y - y) < 0.5)
        .map((i) => i.text);
    };
    const classic = presetSpec('classic');
    expect(header(classic)).toEqual(expect.arrayContaining(['CGST', 'SGST']));
    const combined = header(presetSpec('compact'));
    expect(combined).toContain('Tax');
    expect(combined).not.toContain('CGST');
    const hidden = header({ ...classic, table: { ...classic.table, taxColumns: 'hidden' } });
    expect(hidden).not.toContain('CGST');
    expect(hidden).not.toContain('Tax');
    expect(hidden).toContain('Amount');
  });

  it('a hidden block does not print, and block order changes the order on the page', () => {
    const noBank = {
      ...presetSpec('classic'),
      blocks: presetSpec('classic').blocks.map((b) =>
        b.type === 'bank' ? { ...b, visible: false } : b,
      ),
    };
    expect(allTexts(lay(sampleModel(), noBank).pages)).not.toContain('Bank Details');
    const y = (spec: TemplateSpec, word: string) => {
      const r = lay(sampleModel(), spec);
      return textItems(r.pages[0]!).find((x) => x.text === word)!.y;
    };
    const base = presetSpec('classic');
    expect(y(base, 'Bank Details')).toBeLessThan(y(base, 'Terms and Conditions'));
    const swapped = { ...base, blocks: [...base.blocks].map((b) => b) };
    const bi = swapped.blocks.findIndex((b) => b.type === 'bank');
    const ti = swapped.blocks.findIndex((b) => b.type === 'terms');
    [swapped.blocks[bi], swapped.blocks[ti]] = [swapped.blocks[ti]!, swapped.blocks[bi]!];
    expect(y(swapped, 'Bank Details')).toBeGreaterThan(y(swapped, 'Terms and Conditions'));
  });

  it('a document with no UPI account has no QR code', () => {
    const r = lay(sampleModel({ accounts: [] }));
    expect(r.pages[0]!.items.some((i) => i.t === 'qr')).toBe(false);
    expect(allTexts(r.pages)).not.toContain('Bank Details');
  });
});

describe('wrapping', () => {
  it('breaks on spaces, and breaks a word that is wider than the box', () => {
    expect(wrapText('one two three', 'regular', 10, 30, m)).toEqual(['one', 'two', 'three']);
    expect(wrapText('abcdefghij', 'regular', 10, 20, m)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('', 'regular', 10, 40, m)).toEqual(['']);
    expect(wrapText('a\nb', 'regular', 10, 400, m)).toEqual(['a', 'b']);
  });
});
