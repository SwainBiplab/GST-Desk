/**
 * Pixels from a file: images through a canvas, PDFs through pdf.js (loaded only when a PDF arrives).
 * Pages are scaled so the long side is at most `MAX_SIDE`: enough for OCR, small enough for the laptop.
 */
import type { RasterImage } from '@gst/ai';

export const MAX_SIDE = 2200;

function fromCanvas(canvas: HTMLCanvasElement): RasterImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}

export async function rasterImage(blob: Blob): Promise<RasterImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return fromCanvas(canvas);
  } finally {
    bitmap.close();
  }
}

export async function rasterPdf(bytes: Uint8Array, maxPages = 5): Promise<RasterImage[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const out: RasterImage[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as never)
        .promise;
      out.push(fromCanvas(canvas));
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** Every page of a file as pixels. */
export async function rasterise(bytes: Uint8Array, mime: string): Promise<RasterImage[]> {
  if (mime === 'application/pdf') return rasterPdf(bytes);
  return [await rasterImage(new Blob([bytes as BlobPart], { type: mime }))];
}
