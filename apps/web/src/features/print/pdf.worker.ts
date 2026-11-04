/// <reference lib="webworker" />
/**
 * Makes PDFs off the main thread. Fonts are sent once and kept here; each request carries only the
 * document, so the page never freezes while a long invoice (or twenty) is laid out and written.
 */
import {
  FontMeasurer,
  layoutDocument,
  renderPdf,
  stampPdf,
  type FontBytes,
  type PdfOptions,
  type PrintModel,
  type TemplateSpec,
} from '@gst/print';

export type WorkerRequest =
  | { id: number; type: 'fonts'; fonts: FontBytes }
  | { id: number; type: 'render'; model: PrintModel; spec: TemplateSpec; opts: PdfOptions }
  | { id: number; type: 'stamp'; pdf: Uint8Array; text: string };

export type WorkerReply =
  { id: number; ok: true; pdf?: Uint8Array } | { id: number; ok: false; error: string };

let fonts: FontBytes = {};
let measurer: FontMeasurer | null = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'fonts') {
      fonts = { ...fonts, ...m.fonts };
      measurer = null;
      (self as unknown as Worker).postMessage({ id: m.id, ok: true } satisfies WorkerReply);
      return;
    }
    measurer ??= new FontMeasurer(fonts);
    let pdf: Uint8Array;
    if (m.type === 'render') {
      const r = layoutDocument(m.model, m.spec, { measurer });
      pdf = await renderPdf(r.pages, fonts, m.opts);
    } else {
      pdf = await stampPdf(m.pdf, m.text, fonts);
    }
    (self as unknown as Worker).postMessage({ id: m.id, ok: true, pdf } satisfies WorkerReply, [
      pdf.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: m.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerReply);
  }
};
