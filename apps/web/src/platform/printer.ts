/**
 * Bluetooth thermal printing (prompt 43): ESC/POS bytes to a paired printer over Bluetooth Classic
 * (the serial profile most 58 mm and 80 mm receipt printers speak), through the app's own small native
 * plugin (`apps/mobile/android/.../BtPrinterPlugin.kt`). The bytes come from `@gst/print`'s
 * `receiptBytes`; nothing here knows what a receipt is. A browser has no such printer.
 */
import { registerPlugin } from '@capacitor/core';

import { hasPlugin } from './index';

export interface PairedPrinter {
  name: string;
  address: string;
}

interface BtPrinterPlugin {
  list(): Promise<{ devices: PairedPrinter[] }>;
  print(o: { address: string; data: string }): Promise<{ bytes: number }>;
}

const BtPrinter = registerPlugin<BtPrinterPlugin>('BtPrinter', {
  web: () =>
    Promise.resolve({ list: async () => ({ devices: [] }), print: async () => ({ bytes: 0 }) }),
});

const PRINTER_KEY = 'print.bt';

export const btPrintingSupported = (): boolean => hasPlugin('BtPrinter');

export async function pairedPrinters(): Promise<PairedPrinter[]> {
  if (!btPrintingSupported()) return [];
  return (await BtPrinter.list()).devices;
}

export async function chosenPrinter(): Promise<PairedPrinter | null> {
  if (!hasPlugin('Preferences')) return null;
  const { Preferences } = await import('@capacitor/preferences');
  const v = (await Preferences.get({ key: PRINTER_KEY })).value;
  try {
    return v ? (JSON.parse(v) as PairedPrinter) : null;
  } catch {
    return null;
  }
}

export async function choosePrinter(p: PairedPrinter | null): Promise<void> {
  if (!hasPlugin('Preferences')) return;
  const { Preferences } = await import('@capacitor/preferences');
  if (p) await Preferences.set({ key: PRINTER_KEY, value: JSON.stringify(p) });
  else await Preferences.remove({ key: PRINTER_KEY });
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Send raw ESC/POS bytes. Throws with the printer's reason when it cannot. */
export async function printBytes(printer: PairedPrinter, bytes: Uint8Array): Promise<number> {
  const r = await BtPrinter.print({ address: printer.address, data: toBase64(bytes) });
  return r.bytes;
}
