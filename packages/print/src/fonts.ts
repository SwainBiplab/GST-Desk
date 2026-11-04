/**
 * Fonts and text measurement. The layout engine, the SVG preview and the PDF writer all measure text
 * with the same font files, so a line that fits in the preview fits in the PDF.
 *
 * A document mixes scripts (a Hindi label next to an English name and a rupee amount), and no one font
 * covers them all, so text is split into runs by script and each run uses its own family.
 */
// fontkit's Indic shapers were compiled with generators and expect this global
import 'regenerator-runtime/runtime';
import * as fontkit from '@pdf-lib/fontkit';

export const FONT_FAMILIES = [
  'latin',
  'latinExt',
  'devanagari',
  'tamil',
  'bengali',
  'gujarati',
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export type Weight = 'regular' | 'bold';

export type FontBytes = Partial<Record<`${FontFamily}:${Weight}`, Uint8Array>>;

/** Which family draws a code point. Latin is the default; the rupee sign and other extras are in `latinExt`. */
export function familyOf(cp: number): FontFamily {
  if ((cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff)) return 'devanagari';
  if (cp >= 0x0b80 && cp <= 0x0bff) return 'tamil';
  if (cp >= 0x0980 && cp <= 0x09ff) return 'bengali';
  if (cp >= 0x0a80 && cp <= 0x0aff) return 'gujarati';
  if ((cp >= 0x0100 && cp <= 0x024f) || (cp >= 0x20a0 && cp <= 0x20c0)) return 'latinExt';
  return 'latin';
}

export interface Run {
  text: string;
  family: FontFamily;
}

/**
 * Split text into runs that each use one family. Digits, spaces and ASCII punctuation are always Latin
 * (the Indic and Latin-extended files carry no digits), so "कुल 1,180" is a Devanagari run and a Latin one.
 */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const family: FontFamily = cp < 0x80 ? 'latin' : familyOf(cp);
    const last = runs[runs.length - 1];
    if (last && last.family === family) last.text += ch;
    else runs.push({ text: ch, family });
  }
  return runs;
}

export interface TextMeasurer {
  /** Width of `text` in points at `size`, shaped. */
  width(text: string, weight: Weight, size: number): number;
  /** Ascent and descent as a fraction of the font size (positive numbers). */
  metrics(): { ascent: number; descent: number };
}

/** Measures with real font files. */
export class FontMeasurer implements TextMeasurer {
  private readonly fonts = new Map<string, fontkit.Font>();
  private readonly cache = new Map<string, number>();

  constructor(private readonly bytes: FontBytes) {}

  /** The parsed font for a family and weight; a missing bold falls back to regular, a missing family to Latin. */
  font(family: FontFamily, weight: Weight): fontkit.Font {
    const tries: `${FontFamily}:${Weight}`[] = [
      `${family}:${weight}`,
      `${family}:regular`,
      `latin:${weight}`,
      'latin:regular',
    ];
    for (const key of tries) {
      const have = this.fonts.get(key);
      if (have) return have;
      const raw = this.bytes[key];
      if (raw) {
        const f = fontkit.create(raw);
        this.fonts.set(key, f);
        return f;
      }
    }
    throw new Error('no font loaded: the Latin font is required');
  }

  width(text: string, weight: Weight, size: number): number {
    const key = `${weight}|${size}|${text}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let w = 0;
    for (const run of splitRuns(text)) {
      const f = this.font(run.family, weight);
      w += (f.layout(run.text).advanceWidth / f.unitsPerEm) * size;
    }
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(key, w);
    return w;
  }

  metrics() {
    const f = this.font('latin', 'regular');
    return { ascent: f.ascent / f.unitsPerEm, descent: Math.abs(f.descent) / f.unitsPerEm };
  }
}

/** For tests that should not depend on font files: every character is the same width. */
export class FixedMeasurer implements TextMeasurer {
  constructor(private readonly em = 0.5) {}
  width(text: string, weight: Weight, size: number): number {
    return [...text].length * size * this.em * (weight === 'bold' ? 1.05 : 1);
  }
  metrics() {
    return { ascent: 0.93, descent: 0.25 };
  }
}
