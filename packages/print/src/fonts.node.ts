/** Loads the bundled fonts from disk (Node: tests, scripts, a desktop sidecar). */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { FontBytes, FontFamily, Weight } from './fonts';

const require = createRequire(import.meta.url);

/** Each family's Fontsource package and the subset file that carries its script. */
export const FONT_FILES: Record<FontFamily, { pkg: string; file: (w: 400 | 700) => string }> = {
  latin: { pkg: '@fontsource/noto-sans', file: (w) => `noto-sans-latin-${w}-normal.woff` },
  latinExt: { pkg: '@fontsource/noto-sans', file: (w) => `noto-sans-latin-ext-${w}-normal.woff` },
  devanagari: {
    pkg: '@fontsource/noto-sans-devanagari',
    file: (w) => `noto-sans-devanagari-devanagari-${w}-normal.woff`,
  },
  tamil: {
    pkg: '@fontsource/noto-sans-tamil',
    file: (w) => `noto-sans-tamil-tamil-${w}-normal.woff`,
  },
  bengali: {
    pkg: '@fontsource/noto-sans-bengali',
    file: (w) => `noto-sans-bengali-bengali-${w}-normal.woff`,
  },
  gujarati: {
    pkg: '@fontsource/noto-sans-gujarati',
    file: (w) => `noto-sans-gujarati-gujarati-${w}-normal.woff`,
  },
};

export function loadFontsNode(families: readonly FontFamily[]): FontBytes {
  const out: FontBytes = {};
  for (const family of families) {
    const { pkg, file } = FONT_FILES[family];
    const root = require.resolve(`${pkg}/package.json`).replace(/package\.json$/, '');
    for (const [weight, w] of [
      ['regular', 400],
      ['bold', 700],
    ] as [Weight, 400 | 700][]) {
      out[`${family}:${weight}`] = new Uint8Array(readFileSync(`${root}files/${file(w)}`));
    }
  }
  return out;
}
