import type { FontBytes, PdfOptions, PrintModel, TemplateSpec } from '@gst/print';

import type { WorkerReply, WorkerRequest } from './pdf.worker';

/**
 * Talks to the PDF worker. One worker is kept for the session; `cancel()` ends it (a bulk export the
 * user stopped) and the next call starts a fresh one.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: Uint8Array | undefined) => void; reject: (e: Error) => void }
>();
const sentFonts = new Set<string>();

function start(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.pdf);
    else p.reject(new Error(e.data.error));
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The PDF worker stopped.'));
    pending.clear();
    worker = null;
    sentFonts.clear();
  };
  worker = w;
  return w;
}

/** A request without its id (the client numbers them), keeping each variant's own fields. */
type Body<T = WorkerRequest> = T extends { id: number } ? Omit<T, 'id'> : never;

function call(msg: Body, transfer: Transferable[] = []): Promise<Uint8Array | undefined> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    start().postMessage({ ...msg, id } as WorkerRequest, transfer);
  });
}

async function ensureFonts(fonts: FontBytes): Promise<void> {
  const fresh: FontBytes = {};
  for (const [k, v] of Object.entries(fonts))
    if (v && !sentFonts.has(k)) (fresh as Record<string, Uint8Array>)[k] = v.slice();
  if (Object.keys(fresh).length === 0) return;
  await call({ type: 'fonts', fonts: fresh });
  for (const k of Object.keys(fresh)) sentFonts.add(k);
}

/** Lay out and write the PDF of one document. */
export async function makePdf(
  model: PrintModel,
  spec: TemplateSpec,
  fonts: FontBytes,
  opts: PdfOptions = {},
): Promise<Uint8Array> {
  await ensureFonts(fonts);
  const pdf = await call({ type: 'render', model, spec, opts });
  if (!pdf) throw new Error('The PDF was not made.');
  return pdf;
}

/** Stamp CANCELLED across an existing PDF. */
export async function stampCancelled(
  pdf: Uint8Array,
  text: string,
  fonts: FontBytes,
): Promise<Uint8Array> {
  await ensureFonts(fonts);
  const out = await call({ type: 'stamp', pdf: pdf.slice(), text });
  if (!out) throw new Error('The PDF was not stamped.');
  return out;
}

/** Stop whatever the worker is doing (a cancelled bulk export). */
export function cancelPdfWork(): void {
  worker?.terminate();
  worker = null;
  sentFonts.clear();
  for (const p of pending.values()) p.reject(new Error('Cancelled.'));
  pending.clear();
}
