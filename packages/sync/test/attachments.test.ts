import { describe, expect, it } from 'vitest';

import { AttachmentQueue, type BlobStore, type FileApi } from '../src/attachments';

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function memoryBlobs(): BlobStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    has: async (s) => map.has(s),
    get: async (s) => map.get(s) ?? null,
    put: async (bytes) => {
      const s = await sha(bytes);
      map.set(s, bytes);
      return { sha256: s, storagePath: `memory:${s}` };
    },
  };
}

/** An object store behind signed URLs, with a switch to make it fail. */
function fakeServer() {
  const objects = new Map<string, Uint8Array>();
  const state = { down: false, corrupt: false };
  const api: FileApi = {
    signUpload: async (b) => ({
      key: `orgs/o/attachments/${b.name}`,
      url: `put:orgs/o/attachments/${b.name}`,
      headers: { 'content-type': b.mime },
    }),
    signDownload: async (key) => (objects.has(key) ? { url: `get:${key}` } : null),
    transfer: async (url, init) => {
      if (state.down) return { ok: false, status: 503 };
      const key = url.slice(4);
      if (init.method === 'PUT') {
        objects.set(key, init.body!);
        return { ok: true, status: 200 };
      }
      const b = objects.get(key);
      if (!b) return { ok: false, status: 404 };
      return { ok: true, status: 200, bytes: state.corrupt ? new Uint8Array([1, 2, 3]) : b };
    },
  };
  return { objects, state, api, has: async (s: string) => objects.has(`orgs/o/attachments/${s}`) };
}

describe('the attachment queue', () => {
  it('uploads a file one device made once, and the other device downloads and checks it', async () => {
    const server = fakeServer();
    const a = memoryBlobs();
    const b = memoryBlobs();
    const bytes = new TextEncoder().encode('%PDF-1.4 supplier bill');
    const { sha256 } = await a.put(bytes, 'application/pdf');
    const row = { id: 'r1', sha256, mime: 'application/pdf', size_bytes: bytes.length };

    const qa = new AttachmentQueue('o', a, server.api);
    expect((await qa.run([row, row], server.has)).uploaded).toEqual([sha256]);
    expect((await qa.run([row], server.has)).uploaded).toEqual([]); // once only

    const qb = new AttachmentQueue('o', b, server.api);
    expect((await qb.run([row], server.has)).downloaded).toEqual([sha256]);
    expect(new TextDecoder().decode(b.map.get(sha256)!)).toBe('%PDF-1.4 supplier bill');
  });

  it('waits longer after each failure, refuses a file that does not match its hash, and recovers', async () => {
    const server = fakeServer();
    const a = memoryBlobs();
    const b = memoryBlobs();
    let now = 0;
    const { sha256 } = await a.put(new TextEncoder().encode('scan'), 'image/png');
    const row = { id: 'r1', sha256, mime: 'image/png', size_bytes: 4 };
    await new AttachmentQueue('o', a, server.api).run([row], server.has);

    const qb = new AttachmentQueue('o', b, server.api, () => now);
    server.state.corrupt = true;
    const first = await qb.run([row], server.has);
    expect(first.failed[0]?.message).toMatch(/does not match its hash/);
    expect(b.map.size).toBe(0);
    // not retried before its wait is over
    expect((await qb.run([row], server.has)).failed).toEqual([]);
    server.state.corrupt = false;
    now += 2_001;
    expect((await qb.run([row], server.has)).downloaded).toEqual([sha256]);

    // a missing object is "not there yet", retried later
    const ghost = { id: 'r2', sha256: 'f'.repeat(64), mime: 'image/png', size_bytes: 1 };
    expect((await qb.run([ghost], server.has)).failed[0]?.message).toMatch(/not on the server yet/);
  });
});
