/**
 * Barcode scanning for item lookup (prompt 43): Google's ML Kit through Capacitor on the phone (the
 * scanner module is downloaded by Play services the first time), the browser's own detector where it
 * has one, and otherwise nothing: the item sheet then offers typing the code.
 */
import { hasPlugin } from './index';

export type ScanResult =
  { ok: true; code: string } | { ok: false; reason: 'unsupported' | 'cancelled' };

interface DetectorLike {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}

export function barcodeSupported(): boolean {
  return hasPlugin('BarcodeScanning') || 'BarcodeDetector' in globalThis;
}

export async function scanBarcode(): Promise<ScanResult> {
  if (hasPlugin('BarcodeScanning')) {
    const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { ok: false, reason: 'unsupported' };
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited')
      return { ok: false, reason: 'cancelled' };
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
    try {
      const { barcodes } = await BarcodeScanner.scan();
      const code = barcodes[0]?.rawValue?.trim();
      return code ? { ok: true, code } : { ok: false, reason: 'cancelled' };
    } catch {
      return { ok: false, reason: 'cancelled' };
    }
  }
  if ('BarcodeDetector' in globalThis && typeof navigator.mediaDevices?.getUserMedia === 'function')
    return scanWithBrowser();
  return { ok: false, reason: 'unsupported' };
}

/** The browser's detector over a short camera session: up to ten seconds, four frames a second. */
async function scanWithBrowser(): Promise<ScanResult> {
  const Detector = (globalThis as unknown as { BarcodeDetector: new () => DetectorLike })
    .BarcodeDetector;
  const detector = new Detector();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return { ok: false, reason: 'cancelled' };
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  try {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const found = await detector.detect(video).catch(() => []);
      const code = found[0]?.rawValue?.trim();
      if (code) return { ok: true, code };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, reason: 'cancelled' };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
