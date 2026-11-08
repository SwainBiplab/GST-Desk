/**
 * What a counter plugs into (prompt 52). Receipts go to the paired Bluetooth printer as ESC/POS bytes (with the
 * cash drawer kick after them), or to the browser's print dialog as the thermal layout; the customer display is
 * a second window fed over a BroadcastChannel; a weighing scale is read from a serial port where the browser
 * has Web Serial. USB raw printing from the desktop app is not built yet (B-239). Each function says what it did
 * and never throws, so a missing device never stops a sale.
 */
import { parseScaleReading } from '@gst/domain';
import { CMD, receiptBytes, receiptHtml, type PrintModel, type TemplateSpec } from '@gst/print';

import { btPrintingSupported, chosenPrinter, printBytes } from '@/platform/printer';

export type PrintOutcome = 'printed' | 'browser' | 'failed';

/** Print the receipt: the paired thermal printer if there is one, else the browser's print dialog. */
export async function printReceipt(
  model: PrintModel,
  spec: TemplateSpec,
  o: { drawer: boolean; billQr: boolean },
): Promise<PrintOutcome> {
  try {
    if (btPrintingSupported()) {
      const printer = await chosenPrinter();
      if (printer) {
        await printBytes(
          printer,
          receiptBytes(model, spec, { cashDrawer: o.drawer, billQr: o.billQr, feedLines: 3 }),
        );
        return 'printed';
      }
    }
    printHtml(receiptHtml(model, spec));
    return 'browser';
  } catch {
    return 'failed';
  }
}

/** Open the cash drawer through the printer. False when there is no paired printer to ask. */
export async function kickDrawer(): Promise<boolean> {
  try {
    if (!btPrintingSupported()) return false;
    const printer = await chosenPrinter();
    if (!printer) return false;
    await printBytes(printer, Uint8Array.from([...CMD.init, ...CMD.drawer]));
    return true;
  } catch {
    return false;
  }
}

/** Print an HTML page through a hidden frame, so the counter screen stays where it is. */
export function printHtml(html: string): void {
  // the print frame takes the keyboard focus to print; give it back so the next key reaches the counter
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const restore = () => {
    if (before?.isConnected) before.focus();
    else window.focus();
  };
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    restore();
    setTimeout(() => {
      frame.remove();
      restore();
    }, 1000);
  }, 50);
}

/* ------------------------------------------------------------------ customer display */

export const DISPLAY_CHANNEL = 'gst-pos-display';

export interface DisplayMessage {
  lines: { name: string; qty: string; amount: string }[];
  total: string;
  /** After a sale: what was paid and the change to give. */
  paid?: { paid: string; change: string } | null;
  business: string;
}

export function postDisplay(m: DisplayMessage): void {
  try {
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.postMessage(m);
    ch.close();
  } catch {
    // no BroadcastChannel: the display just stays as it was
  }
}

export function onDisplay(cb: (m: DisplayMessage) => void): () => void {
  try {
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.onmessage = (e) => cb(e.data as DisplayMessage);
    return () => ch.close();
  } catch {
    return () => undefined;
  }
}

/** Open the customer display on a second screen: the same app, in its display mode. */
export function openDisplayWindow(): boolean {
  const w = window.open('/shop/pos?display=1', 'gst-pos-display', 'popup,width=900,height=600');
  return !!w;
}

/* ------------------------------------------------------------------ weighing scale */

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export const scaleSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serial' in navigator;

/**
 * Read a scale on a serial port: each line it sends is parsed (`ST,GS,  0.250kg`), and the stable readings are
 * handed over. Returns a function that stops reading. Needs a person to choose the port the first time.
 */
export async function connectScale(
  onReading: (kgMicros: number, stable: boolean) => void,
  baudRate = 9600,
): Promise<(() => Promise<void>) | null> {
  try {
    const serial = (navigator as unknown as { serial?: SerialLike }).serial;
    if (!serial) return null;
    const port = await serial.requestPort();
    await port.open({ baudRate });
    const reader = port.readable?.getReader();
    if (!reader) return null;
    let stopped = false;
    const decoder = new TextDecoder();
    let buf = '';
    void (async () => {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const r = parseScaleReading(p);
          if (r) onReading(r.kgMicros, r.stable);
        }
      }
    })();
    return async () => {
      stopped = true;
      try {
        await reader.cancel();
        await port.close();
      } catch {
        // already gone
      }
    };
  } catch {
    return null;
  }
}
