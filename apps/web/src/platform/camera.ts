/**
 * Bill capture (prompt 43): the phone's camera through Capacitor, a file input elsewhere. The photo is
 * made smaller on the device before anything reads it (long side 2000 px, JPEG 85%), which is what the
 * OCR wants and a fifth of the bytes to keep; nothing here needs the network.
 */
import { hasPlugin } from './index';

export interface Captured {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export const MAX_SIDE_PX = 2000;
export const JPEG_QUALITY = 0.85;

/** Downscale a photo in the WebView's own canvas; a file that is not an image is kept as it is. */
export async function preprocessImage(
  bytes: Uint8Array,
  mime: string,
  maxSide = MAX_SIDE_PX,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!mime.startsWith('image/') || typeof createImageBitmap !== 'function') return { bytes, mime };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return { bytes, mime };
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && mime === 'image/jpeg') {
    bitmap.close();
    return { bytes, mime };
  }
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!g) {
    bitmap.close();
    return { bytes, mime };
  }
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
      : await new Promise<Blob | null>((r) =>
          (canvas as HTMLCanvasElement).toBlob(r, 'image/jpeg', JPEG_QUALITY),
        );
  if (!blob) return { bytes, mime };
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Open the camera. Resolves null when the person cancels. */
export async function captureBill(): Promise<Captured | null> {
  if (!hasPlugin('Camera')) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  let photo: { webPath?: string; format: string };
  try {
    photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.Uri,
      quality: 90,
      correctOrientation: true,
      saveToGallery: false,
    });
  } catch {
    // the camera was closed, or permission refused: nothing to scan
    return null;
  }
  if (!photo.webPath) return null;
  const raw = new Uint8Array(await (await fetch(photo.webPath)).arrayBuffer());
  const out = await preprocessImage(raw, `image/${photo.format === 'png' ? 'png' : 'jpeg'}`);
  return { name: `bill-${stamp()}.jpg`, bytes: out.bytes, mime: out.mime };
}

/** A file chosen in the browser, made smaller the same way. */
export async function fromFile(f: File): Promise<Captured> {
  const out = await preprocessImage(new Uint8Array(await f.arrayBuffer()), f.type);
  return {
    name: out.mime === f.type ? f.name : f.name.replace(/\.[^.]+$/, '') + '.jpg',
    bytes: out.bytes,
    mime: out.mime,
  };
}
