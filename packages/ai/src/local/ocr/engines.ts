/**
 * OCR engines that talk to something else: the OCR sidecar over HTTP, and a fixture engine for tests and
 * demos that returns text already known for an image. Tesseract in the browser lives in the web app.
 */
import { encodePng } from './png';
import type { OcrEngine, OcrResult, RasterImage } from './types';

interface SidecarBox {
  text: string;
  box: [number, number, number, number];
  confidence?: number;
}

/**
 * The OCR sidecar: `POST /ocr` with a PNG, answer `{ "boxes": [{ "text", "box": [x, y, w, h], "confidence" }] }`.
 * The sidecar wraps a dedicated OCR model with Devanagari and Tamil; its build is the desktop's job.
 */
export class SidecarOcrEngine implements OcrEngine {
  readonly id: string;
  constructor(
    private readonly server: {
      withServer<T>(fn: (h: { baseUrl: string }) => Promise<T>, signal?: AbortSignal): Promise<T>;
    },
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.id = `sidecar:${model}`;
  }

  async recognise(
    image: RasterImage,
    opts: { languages?: string[]; signal?: AbortSignal } = {},
  ): Promise<OcrResult> {
    const png = encodePng(image);
    return this.server.withServer(async (h) => {
      const form = new FormData();
      form.append('image', new Blob([png as BlobPart], { type: 'image/png' }), 'page.png');
      form.append('languages', (opts.languages ?? ['en', 'hi']).join(','));
      const res = await this.fetchFn(`${h.baseUrl}/ocr`, {
        method: 'POST',
        body: form,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw new Error(`ocr answered ${res.status}`);
      const j = (await res.json()) as { boxes?: SidecarBox[] };
      return {
        width: image.width,
        height: image.height,
        engine: this.id,
        boxes: (j.boxes ?? []).map((b) => ({
          text: b.text,
          x: b.box[0],
          y: b.box[1],
          w: b.box[2],
          h: b.box[3],
          confidence: b.confidence ?? 0.9,
        })),
      };
    }, opts.signal);
  }
}

/** Lines of text laid out as boxes, one row each, for tests and the demo. */
export function boxesFromLines(
  lines: string[],
  width = 1000,
  lineHeight = 28,
  confidence = 0.95,
): OcrResult {
  const boxes = lines.flatMap((line, row) => {
    const y = 20 + row * lineHeight;
    // columns separated by two or more spaces keep a gap; words inside a column sit close together
    let x = 20;
    return line.split(/ {2,}/).flatMap((col) => {
      const out = col
        .split(/ +/)
        .filter(Boolean)
        .map((word) => {
          const w = word.length * 11;
          const b = { text: word, x, y, w, h: lineHeight - 6, confidence };
          x += w + 8;
          return b;
        });
      x += lineHeight * 2;
      return out;
    });
  });
  return { width, height: 40 + lines.length * lineHeight, boxes, engine: 'fixture' };
}

/** Answers from a table of known results, by the image's size; anything else gives no boxes. */
export class FixtureOcrEngine implements OcrEngine {
  readonly id = 'fixture';
  constructor(private readonly byKey: (image: RasterImage) => string[] | null) {}
  async recognise(image: RasterImage): Promise<OcrResult> {
    const lines = this.byKey(image);
    return lines
      ? boxesFromLines(lines, image.width)
      : { width: image.width, height: image.height, boxes: [], engine: this.id };
  }
}
