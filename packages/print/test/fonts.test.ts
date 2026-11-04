import { describe, expect, it } from 'vitest';

import { FixedMeasurer, FontMeasurer, familyOf, splitRuns } from '../src/fonts';
import { loadFontsNode } from '../src/fonts.node';

describe('script runs', () => {
  it('splits mixed text by script; digits, spaces and punctuation are Latin', () => {
    expect(splitRuns('कुल Total 1,180.00')).toEqual([
      { text: 'कुल', family: 'devanagari' },
      { text: ' Total 1,180.00', family: 'latin' },
    ]);
    expect(splitRuns('₹ 1,180')).toEqual([
      { text: '₹', family: 'latinExt' },
      { text: ' 1,180', family: 'latin' },
    ]);
    expect(splitRuns('')).toEqual([]);
  });

  it('picks a family for each Indian script', () => {
    expect(familyOf(0x0915)).toBe('devanagari');
    expect(familyOf(0x0b95)).toBe('tamil');
    expect(familyOf(0x0995)).toBe('bengali');
    expect(familyOf(0x0a95)).toBe('gujarati');
    expect(familyOf(0x20b9)).toBe('latinExt');
    expect(familyOf(65)).toBe('latin');
  });
});

describe('measuring', () => {
  const fonts = loadFontsNode(['latin', 'latinExt', 'devanagari', 'tamil', 'bengali', 'gujarati']);
  const m = new FontMeasurer(fonts);

  it('measures real text: wider for more characters, for bold, and for a larger size', () => {
    const a = m.width('Invoice', 'regular', 10);
    expect(a).toBeGreaterThan(20);
    expect(m.width('Invoice Number', 'regular', 10)).toBeGreaterThan(a);
    expect(m.width('Invoice', 'bold', 10)).toBeGreaterThan(a);
    expect(m.width('Invoice', 'regular', 20)).toBeCloseTo(a * 2, 5);
  });

  it('measures every Indian script and the rupee sign', () => {
    for (const s of [
      'कर चालान',
      'வரி விலைப்பட்டியல்',
      'কর চালান',
      'ટેક્સ ઇન્વોઇસ',
      '₹ 1,18,000.00',
    ]) {
      expect(m.width(s, 'regular', 10), s).toBeGreaterThan(5);
    }
    // the rupee sign has a glyph in the font (not the "missing glyph" box, which has no entry)
    const ext = m.font('latinExt', 'regular');
    expect(ext.hasGlyphForCodePoint(0x20b9)).toBe(true);
  });

  it('shapes Indic text: the width of a conjunct is not the sum of its letters', () => {
    const dev = m.font('devanagari', 'regular');
    const letters = [...'क्ष'].map((c) => dev.layout(c).advanceWidth).reduce((a, b) => a + b, 0);
    expect(dev.layout('क्ष').advanceWidth).toBeLessThan(letters);
  });

  it('a fixed measurer is simple and predictable', () => {
    expect(new FixedMeasurer(0.5).width('abcd', 'regular', 10)).toBe(20);
  });
});
