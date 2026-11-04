/**
 * File storage for attachments. Bytes live in OPFS (browser and desktop webview) under their SHA-256,
 * so identical files are stored once; the database keeps only metadata. If OPFS is unavailable
 * the bytes stay in memory for the session.
 */

const DIR = 'gst-attachments';
const memory = new Map<string, Blob>();

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

export interface StoredBlob {
  sha256: string;
  sizeBytes: number;
  mime: string;
  /** Where the bytes are: `opfs:<sha256>` or `memory:<sha256>`. */
  storagePath: string;
}

export async function putBlob(blob: Blob): Promise<StoredBlob> {
  const bytes = await blob.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const meta = { sha256, sizeBytes: blob.size, mime: blob.type || 'application/octet-stream' };
  const d = await dir();
  if (d) {
    try {
      const handle = await d.getFileHandle(sha256, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return { ...meta, storagePath: `opfs:${sha256}` };
    } catch {
      /* fall through to memory */
    }
  }
  memory.set(sha256, blob);
  return { ...meta, storagePath: `memory:${sha256}` };
}

export async function getBlob(
  storagePath: string,
  mime = 'application/octet-stream',
): Promise<Blob | null> {
  const [kind, sha] = storagePath.split(':');
  if (!sha) return null;
  if (kind === 'memory') return memory.get(sha) ?? null;
  const d = await dir();
  if (!d) return null;
  try {
    const file = await (await d.getFileHandle(sha)).getFile();
    return new Blob([await file.arrayBuffer()], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Scale an image to fit within `max` pixels on its longest side and re-encode as PNG.
 * Never enlarges. Throws if the file is not a decodable image.
 */
export async function resizeImage(file: Blob, max = 512): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas is not available');
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('could not encode image'))),
      'image/png',
    ),
  );
}
