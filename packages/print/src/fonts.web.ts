/**
 * Loads the bundled fonts in the browser. Each font file is a separate asset the bundler fingerprints
 * and the app fetches the first time a document needs that script, then keeps (the service worker
 * caches them, so printing works offline after the first print).
 */
import latin from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import latinBold from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';
import latinExt from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url';
import latinExtBold from '@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff?url';
import bengali from '@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff?url';
import bengaliBold from '@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-700-normal.woff?url';
import devanagari from '@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff?url';
import devanagariBold from '@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-700-normal.woff?url';
import gujarati from '@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-400-normal.woff?url';
import gujaratiBold from '@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-700-normal.woff?url';
import tamil from '@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-400-normal.woff?url';
import tamilBold from '@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-700-normal.woff?url';

import type { FontBytes, FontFamily, Weight } from './fonts';

export const FONT_URLS: Record<`${FontFamily}:${Weight}`, string> = {
  'latin:regular': latin,
  'latin:bold': latinBold,
  'latinExt:regular': latinExt,
  'latinExt:bold': latinExtBold,
  'devanagari:regular': devanagari,
  'devanagari:bold': devanagariBold,
  'tamil:regular': tamil,
  'tamil:bold': tamilBold,
  'bengali:regular': bengali,
  'bengali:bold': bengaliBold,
  'gujarati:regular': gujarati,
  'gujarati:bold': gujaratiBold,
};

const loaded = new Map<string, Promise<Uint8Array>>();

async function fetchBytes(key: keyof typeof FONT_URLS): Promise<Uint8Array> {
  const hit = loaded.get(key);
  if (hit) return hit;
  const p = fetch(FONT_URLS[key]).then(async (r) => {
    if (!r.ok) throw new Error(`could not load the font ${key} (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  });
  // a failed load is not remembered, so the next print tries again
  p.catch(() => loaded.delete(key));
  loaded.set(key, p);
  return p;
}

/** Fetch the font files for these families (both weights). Latin is always included. */
export async function loadFontsWeb(families: readonly FontFamily[]): Promise<FontBytes> {
  const want = new Set<FontFamily>(['latin', 'latinExt', ...families]);
  const out: FontBytes = {};
  await Promise.all(
    [...want].flatMap((family) =>
      (['regular', 'bold'] as Weight[]).map(async (w) => {
        out[`${family}:${w}`] = await fetchBytes(`${family}:${w}`);
      }),
    ),
  );
  return out;
}

/** The CSS font-family name a family is registered under for the SVG preview. */
export const cssFamily = (family: FontFamily): string => `GST ${family}`;

const registered = new Set<string>();

/** Make the loaded fonts available to the page's own text rendering (the SVG preview and printing). */
export async function registerBrowserFonts(bytes: FontBytes): Promise<void> {
  for (const [key, data] of Object.entries(bytes)) {
    if (!data || registered.has(key)) continue;
    const [family, weight] = key.split(':') as [FontFamily, Weight];
    const face = new FontFace(cssFamily(family), data.slice().buffer as ArrayBuffer, {
      weight: weight === 'bold' ? '700' : '400',
    });
    await face.load();
    document.fonts.add(face);
    registered.add(key);
  }
}
