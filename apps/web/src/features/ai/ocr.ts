/**
 * Which OCR engine to use: the sidecar (desktop, when its model and runtime are downloaded), else
 * Tesseract in the page with the language files the model manager fetched, else none (the person is
 * told to enable offline AI). In demo mode a fixture engine answers so the flow can be tried without models.
 */
import {
  FixtureOcrEngine,
  SidecarOcrEngine,
  boxesFromLines,
  encodePng,
  type OcrEngine,
  type OcrResult,
  type RasterImage,
} from '@gst/ai';

import { isDesktop } from '../desktop/bridge';

import { modelManager, modelStorage } from './models';
import { keeperFor } from './runtime';
import type { AiSettings } from './settings';

/** The sample bill the demo scans, so the inbox card can be tried without a model. */
export const DEMO_BILL_LINES = [
  'SHREE GANESH TRADERS',
  '12, Market Road, Pune 411001',
  'GSTIN: 27AAPFU0939F1ZV   Phone: 9876543210',
  'TAX INVOICE',
  'Invoice No: SGT/2026/0412        Date: 15/06/2026',
  'S.No  Description          HSN   Qty   Rate     Amount',
  '1     Cement OPC 53 50kg   2523  20    380.00   7600.00',
  '2     TMT Bar 12mm         7214  100   62.50    6250.00',
  'Sub Total                                       13850.00',
  'CGST 9%                                         1246.50',
  'SGST 9%                                         1246.50',
  'Grand Total                                     16343.00',
];

export const demoOcrEngine = (): OcrEngine => new FixtureOcrEngine(() => DEMO_BILL_LINES);

/** Tesseract in the browser. Worker and core come with the app; language data from the model manager. */
export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract';
  constructor(private readonly languages: string[]) {}

  async recognise(image: RasterImage, opts: { signal?: AbortSignal } = {}): Promise<OcrResult> {
    const { createWorker } = await import('tesseract.js');
    const { set } = await import('idb-keyval');
    const storage = modelStorage();
    // the worker looks in its IndexedDB cache before the network: put the downloaded data there, under
    // the key it will ask for, so nothing is fetched
    const langs: string[] = [];
    for (const l of this.languages) {
      if (!('blob' in storage)) continue;
      const bytes = new Uint8Array(await (await storage.blob(`${l}.traineddata`)).arrayBuffer());
      await set(`./${l}.traineddata`, bytes);
      langs.push(l);
    }
    if (!langs.length) throw new Error('no OCR language data downloaded');
    const worker = await createWorker(langs, 1, {
      cacheMethod: 'readOnly',
      gzip: false,
      workerPath: new URL('tesseract.js/dist/worker.min.js', import.meta.url).toString(),
      corePath: new URL('tesseract.js-core', import.meta.url).toString(),
    } as never);
    try {
      if (opts.signal?.aborted) throw new Error('cancelled');
      const png = encodePng(image);
      const { data } = await worker.recognize(
        new Blob([png as BlobPart], { type: 'image/png' }),
        {},
        { blocks: true },
      );
      const words = (data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)),
      );
      return {
        width: image.width,
        height: image.height,
        engine: this.id,
        boxes: words.map((w) => ({
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          confidence: w.confidence / 100,
        })),
      };
    } finally {
      await worker.terminate();
    }
  }
}

export type OcrChoiceResult =
  { engine: OcrEngine; why: 'demo' | 'sidecar' | 'tesseract' } | { engine: null; why: 'none' };

/** Pick the engine the settings and the downloaded models allow. */
export function chooseOcrEngine(settings: AiSettings, demo: boolean): OcrChoiceResult {
  if (demo) return { engine: demoOcrEngine(), why: 'demo' };
  const m = modelManager();
  const sidecarModel =
    settings.ocrModelId && m.get(settings.ocrModelId)?.status === 'ready'
      ? m.entry(settings.ocrModelId)
      : null;
  const runtimeReady = m.ready('runtime').some((e) => e.id.startsWith('ocr-'));
  if (isDesktop() && sidecarModel && runtimeReady && settings.ocr !== 'tesseract')
    return {
      engine: new SidecarOcrEngine(keeperFor('ocr', sidecarModel.file), sidecarModel.id),
      why: 'sidecar',
    };
  const langs = settings.ocrLanguages.filter((l) => m.get(`tess-${l}`)?.status === 'ready');
  if (langs.length && settings.ocr !== 'sidecar')
    return { engine: new TesseractEngine(langs), why: 'tesseract' };
  return { engine: null, why: 'none' };
}

/** For tests of the fixture engine's shape. */
export const fixtureBoxes = (lines: string[], width: number) => boxesFromLines(lines, width);
