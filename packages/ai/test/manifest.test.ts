import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundleFor, verifyManifest, type SigningPublicKey } from '../src';

const data = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', f), 'utf8'));

describe('the shipped model manifest', () => {
  it('verifies with the key the app carries, and the web copy is the same file', async () => {
    const key = data('model-signing-key.json') as SigningPublicKey;
    const check = await verifyManifest(data('models.json'), key);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const web = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'public', 'ai', 'models.json'),
        'utf8',
      ),
    );
    expect(web.signature).toBe(check.manifest.signature);
    // every bundle names models that exist, and every model has a licence summary and a real hash
    const ids = new Set(check.manifest.models.map((m) => m.id));
    for (const b of check.manifest.bundles)
      for (const id of b.models) expect(ids.has(id)).toBe(true);
    for (const m of check.manifest.models) {
      expect(m.licence.summary.length).toBeGreaterThan(10);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(100_000);
    }
    // the baseline laptop gets a text model, OCR, speech and vectors
    const baseline = bundleFor(check.manifest, 'baseline', { ramGb: 8, platform: 'linux-x64' });
    expect(new Set(baseline.map((m) => m.kind))).toEqual(
      new Set(['ocr-lang', 'llm', 'embedding', 'whisper']),
    );
    // a 4 GB machine is offered OCR only
    expect(
      bundleFor(check.manifest, 'minimal', { ramGb: 4, platform: 'linux-x64' }).every(
        (m) => m.kind === 'ocr-lang',
      ),
    ).toBe(true);
  });
});
