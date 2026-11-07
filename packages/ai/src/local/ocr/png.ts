/** A PNG writer for RGBA pixels (stored, not compressed: the sidecar is on the same machine). */
import type { RasterImage } from './types';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t);
  body.set(data, t.length);
  return new Uint8Array([...u32(data.length), ...body, ...u32(crc32(body))]);
}

export function encodePng(img: RasterImage): Uint8Array {
  const stride = img.width * 4 + 1;
  const raw = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * stride] = 0;
    raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * stride + 1);
  }
  // zlib stream of stored blocks (max 65535 bytes each)
  const blocks: number[] = [0x78, 0x01];
  for (let at = 0; at < raw.length; at += 65535) {
    const n = Math.min(65535, raw.length - at);
    const last = at + n >= raw.length ? 1 : 0;
    blocks.push(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255);
    for (let i = 0; i < n; i++) blocks.push(raw[at + i]!);
  }
  blocks.push(...u32(adler32(raw)));
  const ihdr = new Uint8Array([...u32(img.width), ...u32(img.height), 8, 6, 0, 0, 0]);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const parts = [
    new Uint8Array(sig),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(blocks)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
