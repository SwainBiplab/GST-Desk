/** Which file types a purchase bill may carry, decided by the first bytes, never by the file name. */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  sig.every((x, i) => b[at + i] === x);

/** The real type of a file from its magic bytes, or null when it is not one we accept. */
export function sniffMime(bytes: Uint8Array): AttachmentMime | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  return null;
}

export type AttachmentCheck =
  { ok: true; mime: AttachmentMime } | { ok: false; reason: 'empty' | 'too_big' | 'type' };

export function checkAttachment(bytes: Uint8Array): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too_big' };
  const mime = sniffMime(bytes);
  return mime ? { ok: true, mime } : { ok: false, reason: 'type' };
}
