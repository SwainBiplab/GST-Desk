/**
 * The share sheet (prompt 43): on the phone the file is written to the app's cache and handed to the
 * system sheet (WhatsApp is one tap away); a browser that can share files does the same through
 * `navigator.share`; otherwise the caller falls back to a download and a WhatsApp link.
 */
import { hasPlugin } from './index';

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported';

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function shareFile(o: {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  text?: string;
  title?: string;
}): Promise<ShareOutcome> {
  if (hasPlugin('Share') && hasPlugin('Filesystem')) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const { uri } = await Filesystem.writeFile({
      path: `share/${o.fileName}`,
      data: toBase64(o.bytes),
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({
        files: [uri],
        ...(o.text ? { text: o.text } : {}),
        ...(o.title ? { title: o.title } : {}),
      });
      return 'shared';
    } catch (e) {
      return /cancel/i.test(e instanceof Error ? e.message : String(e))
        ? 'cancelled'
        : 'unsupported';
    }
  }
  const file = new File([o.bytes.slice().buffer as ArrayBuffer], o.fileName, { type: o.mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({
        files: [file],
        ...(o.text ? { text: o.text } : {}),
        ...(o.title ? { title: o.title } : {}),
      });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  return 'unsupported';
}

/** Open a link in the system (a UPI app, WhatsApp): the phone's app chooser, a new tab elsewhere. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}
