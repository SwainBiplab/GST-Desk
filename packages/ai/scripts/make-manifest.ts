/**
 * Build and sign the model manifest from data/models.source.json.
 *
 *   pnpm --filter @gst/ai exec tsx scripts/make-manifest.ts [--key path/to/private.json] [--out path]
 *
 * Sizes and SHA-256 hashes come from the hosts: Hugging Face sends them in `x-linked-size` and
 * `x-linked-etag`; any other file is downloaded and hashed here. The private key defaults to the
 * development key in data/ (the release pipeline passes its own, which never enters the repository).
 * Writes data/models.json and apps/web/public/ai/models.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  manifestSchema,
  signManifest,
  verifyManifest,
  type ModelEntry,
  type UnsignedManifest,
} from '../src';

const here = import.meta.dirname;
const args = new Map<string, string>();
process.argv
  .slice(2)
  .forEach((a, i, all) => a.startsWith('--') && args.set(a.slice(2), all[i + 1] ?? ''));
const keyPath = args.get('key') || join(here, '..', 'data', 'model-signing-key.dev-private.json');
const source = JSON.parse(readFileSync(join(here, '..', 'data', 'models.source.json'), 'utf8')) as {
  models: Partial<ModelEntry>[];
  bundles: UnsignedManifest['bundles'];
};

/** Files on Hugging Face: the file API lists the LFS size and SHA-256, so nothing is downloaded. */
async function fromHuggingFace(url: string): Promise<{ sizeBytes: number; sha256: string } | null> {
  const m = url.match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, repo, rev, path] = m;
  const dir = path!.includes('/') ? path!.slice(0, path!.lastIndexOf('/')) : '';
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/${rev}/${dir}`);
  if (!res.ok) throw new Error(`${repo}: tree api answered ${res.status}`);
  const rows = (await res.json()) as {
    path: string;
    size?: number;
    lfs?: { oid: string; size: number };
  }[];
  const row = rows.find((r) => r.path === path);
  if (!row) throw new Error(`${repo}: ${path} is not in the tree`);
  if (row.lfs?.oid && row.lfs.size) return { sizeBytes: row.lfs.size, sha256: row.lfs.oid };
  return null;
}

const MAX_DOWNLOAD = 64 * 1024 * 1024;

async function sizeAndHash(url: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hf = await fromHuggingFace(url);
  if (hf) return hf;
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const len = Number(head.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD && !args.has('download-big'))
    throw new Error(`${url} is ${len} bytes; pass --download-big to download and hash it`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const h = createHash('sha256');
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    n += value.length;
  }
  return { sizeBytes: n, sha256: h.digest('hex') };
}

const models: ModelEntry[] = [];
for (const m of source.models) {
  const have =
    m.sizeBytes && m.sha256
      ? { sizeBytes: m.sizeBytes, sha256: m.sha256 }
      : await sizeAndHash(m.url!);
  const entry = { platforms: [], languages: [], notes: '', ...m, ...have } as ModelEntry;
  models.push(entry);
  console.log(`${entry.id.padEnd(28)} ${String(entry.sizeBytes).padStart(12)}  ${entry.sha256}`);
}
const unsigned: UnsignedManifest = {
  format: 1,
  generatedAt: new Date().toISOString(),
  models,
  bundles: source.bundles,
};
manifestSchema.omit({ keyId: true, signature: true }).parse(unsigned);
const key = JSON.parse(readFileSync(keyPath, 'utf8')) as {
  keyId: string;
  privateKeyPkcs8Base64: string;
};
const signed = await signManifest(unsigned, {
  keyId: key.keyId,
  privateKeyPkcs8: Uint8Array.from(Buffer.from(key.privateKeyPkcs8Base64, 'base64')),
});
const pub = JSON.parse(readFileSync(join(here, '..', 'data', 'model-signing-key.json'), 'utf8'));
const check = await verifyManifest(signed, pub);
if (!check.ok)
  throw new Error(
    `the signed manifest does not verify with data/model-signing-key.json (${check.reason})`,
  );
const text = JSON.stringify(signed, null, 2) + '\n';
const out = args.get('out') || join(here, '..', 'data', 'models.json');
writeFileSync(out, text);
const web = join(here, '..', '..', '..', 'apps', 'web', 'public', 'ai');
mkdirSync(web, { recursive: true });
writeFileSync(join(web, 'models.json'), text);
console.log(`wrote ${out} and apps/web/public/ai/models.json (${models.length} models)`);
