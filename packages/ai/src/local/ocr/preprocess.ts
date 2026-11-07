/**
 * Cleaning a photo or scan before OCR: grey, a light denoise, a binarising threshold chosen from the
 * histogram (Otsu), the skew angle found by trying angles and keeping the one with the sharpest row
 * profile, and a crop to the printed area. Pure functions over pixel arrays; no canvas needed.
 */
import type { GreyImage, RasterImage } from './types';

export function toGrey(img: RasterImage): GreyImage {
  const out = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4)
    out[i] = (img.data[p]! * 299 + img.data[p + 1]! * 587 + img.data[p + 2]! * 114) / 1000;
  return { width: img.width, height: img.height, data: out };
}

export function toRaster(g: GreyImage): RasterImage {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, p = 0; i < g.data.length; i++, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = g.data[i]!;
    out[p + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** Otsu's threshold: the grey level that best separates ink from paper. */
export function otsu(g: GreyImage): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of g.data) hist[v]!++;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export function binarise(g: GreyImage, threshold = otsu(g)): GreyImage {
  const data = new Uint8ClampedArray(g.data.length);
  for (let i = 0; i < data.length; i++) data[i] = g.data[i]! > threshold ? 255 : 0;
  return { width: g.width, height: g.height, data };
}

/** 3x3 median: removes salt-and-pepper speckle from a phone photo without blurring the strokes. */
export function denoise(g: GreyImage): GreyImage {
  const { width: w, height: h } = g;
  const out = new Uint8ClampedArray(g.data.length);
  const win = new Array<number>(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          win[n++] = g.data[yy * w + xx]!;
        }
      }
      win.sort((a, b) => a - b);
      out[y * w + x] = win[4]!;
    }
  }
  return { width: w, height: h, data: out };
}

/** Every `step`-th pixel in both directions, for the skew search. */
export function downsample(g: GreyImage, step: number): GreyImage {
  if (step <= 1) return g;
  const w = Math.max(1, Math.floor(g.width / step));
  const h = Math.max(1, Math.floor(g.height / step));
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data[y * w + x] = g.data[y * step * g.width + x * step]!;
  return { width: w, height: h, data };
}

/** Rotate about the centre by `deg` (counter-clockwise positive), nearest neighbour, paper-white outside. */
export function rotate(g: GreyImage, deg: number): GreyImage {
  const { width: w, height: h } = g;
  const out = new Uint8ClampedArray(w * h).fill(255);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cx + dx * cos + dy * sin);
      const sy = Math.round(cy - dx * sin + dy * cos);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = g.data[sy * w + sx]!;
    }
  }
  return { width: w, height: h, data: out };
}

/** Variance of the per-row ink count: text lines on straight rows give a spiky profile, skewed ones a smooth one. */
function profileVariance(bin: GreyImage): number {
  const rows = new Array<number>(bin.height).fill(0);
  for (let y = 0; y < bin.height; y++)
    for (let x = 0; x < bin.width; x++) if (bin.data[y * bin.width + x] === 0) rows[y]!++;
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  return rows.reduce((a, r) => a + (r - mean) ** 2, 0) / rows.length;
}

/**
 * The angle (degrees) the page is tilted by, within ±`range`. Coarse then fine search on a small copy, so
 * a 2500 px scan takes well under a second.
 */
export function estimateSkew(g: GreyImage, range = 6): number {
  const small = binarise(downsample(g, Math.max(1, Math.round(Math.max(g.width, g.height) / 400))));
  const score = (a: number) => profileVariance(rotate(small, -a));
  let best = 0;
  let bestScore = -1;
  for (let a = -range; a <= range; a += 1) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  for (let a = best - 0.9; a <= best + 0.9; a += 0.3) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return Math.round(best * 10) / 10;
}

export function deskew(g: GreyImage): { image: GreyImage; angle: number } {
  const angle = estimateSkew(g);
  return { image: Math.abs(angle) >= 0.3 ? rotate(g, -angle) : g, angle };
}

/** The box around the ink with a margin, so a bill photographed on a desk loses the desk. */
export function contentBounds(
  bin: GreyImage,
  margin = 12,
): { x: number; y: number; w: number; h: number } {
  const { width: w, height: h } = bin;
  const cols = new Array<number>(w).fill(0);
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (bin.data[y * w + x] === 0) {
        cols[x]!++;
        rows[y]!++;
      }
  // a column or row counts once it holds more than a speck
  const minCol = Math.max(2, h * 0.002);
  const minRow = Math.max(2, w * 0.002);
  let x0 = cols.findIndex((c) => c > minCol);
  let x1 = cols.length - 1 - [...cols].reverse().findIndex((c) => c > minCol);
  let y0 = rows.findIndex((c) => c > minRow);
  let y1 = rows.length - 1 - [...rows].reverse().findIndex((c) => c > minRow);
  if (x0 < 0 || y0 < 0) return { x: 0, y: 0, w, h };
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(g: GreyImage, r: { x: number; y: number; w: number; h: number }): GreyImage {
  const data = new Uint8ClampedArray(r.w * r.h);
  for (let y = 0; y < r.h; y++)
    data.set(g.data.subarray((r.y + y) * g.width + r.x, (r.y + y) * g.width + r.x + r.w), y * r.w);
  return { width: r.w, height: r.h, data };
}

export interface Prepared {
  image: RasterImage;
  grey: GreyImage;
  angle: number;
  cropped: { x: number; y: number; w: number; h: number };
}

/** The whole chain: grey, denoise, deskew, crop. The result is what the OCR engine is given. */
export function prepare(
  img: RasterImage,
  opts: { denoise?: boolean; deskew?: boolean; crop?: boolean } = {},
): Prepared {
  let g = toGrey(img);
  if (opts.denoise ?? true) g = denoise(g);
  let angle = 0;
  if (opts.deskew ?? true) {
    const d = deskew(g);
    g = d.image;
    angle = d.angle;
  }
  let box = { x: 0, y: 0, w: g.width, h: g.height };
  if (opts.crop ?? true) {
    box = contentBounds(binarise(g));
    if (box.w < g.width || box.h < g.height) g = crop(g, box);
  }
  return { image: toRaster(g), grey: g, angle, cropped: box };
}
