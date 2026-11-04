import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyHsnManifest, type HsnDataFile, type HsnManifest } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import {
  SourceError,
  buildHsnVersion,
  bundledModule,
  generateKeys,
  publicKeyOf,
  serialiseData,
  verifyDirectory,
  type PublicKeyFile,
} from '../src/lib';
import { PATHS } from '../src/paths';

const CSV = [
  'code,description,rate_percent,cess_percent,effective_from',
  '1001,Wheat,0,0,2025-09-22',
  '0902,"Tea, flavoured",5,0,2025-09-22',
].join('\n');

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'hsn-'));
  const keys = generateKeys('test-key');
  return { dir, keys };
}

describe('building a version', () => {
  it('writes sorted data and a manifest that verifies', async () => {
    const { dir, keys } = await setup();
    const { data, manifest } = await buildHsnVersion({
      csvText: CSV,
      outDir: dir,
      version: '2026.1.0',
      asOf: '2026-01-01',
      source: 'test',
      privateKeyPem: keys.privateKeyPem,
      keyId: 'test-key',
    });
    expect(data.rows.map((r) => r.code)).toEqual(['0902', '1001']);
    const text = await readFile(join(dir, manifest.file), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      version: '2026.1.0',
      rows: [{ code: '0902', rate_bp: 500 }, {}],
    });
    expect(
      await verifyHsnManifest({ manifest, dataText: text, publicKey: keys.publicKey }),
    ).toEqual({ ok: true });
    expect(await verifyDirectory(dir, keys.publicKey)).toEqual([
      { file: 'hsn-v2026.1.0.manifest.json', version: '2026.1.0', ok: true },
    ]);
    expect(await readFile(join(dir, 'bundled.ts'), 'utf8')).toBe(bundledModule('2026.1.0'));
  });

  it('can skip rewriting the bundled loader', async () => {
    const { dir, keys } = await setup();
    await buildHsnVersion({
      csvText: CSV,
      outDir: dir,
      version: '1.0',
      asOf: '2026-01-01',
      source: 's',
      privateKeyPem: keys.privateKeyPem,
      keyId: 'k',
      bundle: false,
    });
    await expect(readFile(join(dir, 'bundled.ts'))).rejects.toThrow();
  });

  it('reports every bad source line and writes nothing', async () => {
    const { dir, keys } = await setup();
    const bad = `${CSV}\nxx,Bad,5,0,2025-09-22\n1006,Rice,lots,0,2025-09-22`;
    const err = await buildHsnVersion({
      csvText: bad,
      outDir: dir,
      version: '1',
      asOf: '2026-01-01',
      source: 's',
      privateKeyPem: keys.privateKeyPem,
      keyId: 'k',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).errors.map((e) => e.line)).toEqual([4, 5]);
    expect((err as SourceError).message).toContain('line 4');
  });

  it('rejects a malformed version or date', async () => {
    const { dir, keys } = await setup();
    const base = {
      csvText: CSV,
      outDir: dir,
      source: 's',
      privateKeyPem: keys.privateKeyPem,
      keyId: 'k',
    };
    await expect(buildHsnVersion({ ...base, version: 'v1', asOf: '2026-01-01' })).rejects.toThrow(
      /version/,
    );
    await expect(buildHsnVersion({ ...base, version: '1', asOf: 'today' })).rejects.toThrow(
      /as-of/,
    );
  });

  it('fails verification after the data file is edited or the wrong key is used', async () => {
    const { dir, keys } = await setup();
    const { manifest } = await buildHsnVersion({
      csvText: CSV,
      outDir: dir,
      version: '3.0',
      asOf: '2026-01-01',
      source: 's',
      privateKeyPem: keys.privateKeyPem,
      keyId: 'test-key',
    });
    const other = generateKeys('test-key').publicKey;
    expect((await verifyDirectory(dir, other))[0]).toMatchObject({
      ok: false,
      reason: 'signature',
    });
    const file = join(dir, manifest.file);
    await writeFile(file, (await readFile(file, 'utf8')).replace('"rate_bp":500', '"rate_bp":0'));
    expect((await verifyDirectory(dir, keys.publicKey))[0]).toMatchObject({
      ok: false,
      reason: 'hash',
    });
  });

  it('derives the public key from a private key and serialises one row per line', () => {
    const k = generateKeys('x');
    expect(publicKeyOf(k.privateKeyPem)).toBe(k.publicKey.publicKeyBase64);
    const data: HsnDataFile = { version: '1', as_of: '2026-01-01', source: 's', rows: [] };
    expect(JSON.parse(serialiseData(data))).toEqual(data);
  });
});

describe('the version that ships in the app', () => {
  it('verifies against the committed public key', async () => {
    const pub = JSON.parse(await readFile(PATHS.publicKey, 'utf8')) as PublicKeyFile;
    const reports = await verifyDirectory(PATHS.data, pub);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.filter((r) => !r.ok)).toEqual([]);
  });

  it('points the loader at an existing, signed version', async () => {
    const loader = await readFile(join(PATHS.data, 'bundled.ts'), 'utf8');
    const version = /BUNDLED_HSN_VERSION = '([^']+)'/.exec(loader)![1]!;
    const manifest = JSON.parse(
      await readFile(join(PATHS.data, `hsn-v${version}.manifest.json`), 'utf8'),
    ) as HsnManifest;
    expect(manifest.version).toBe(version);
  });

  it('lists every SAC heading and the common goods chapters', async () => {
    const loader = await readFile(join(PATHS.data, 'bundled.ts'), 'utf8');
    const version = /BUNDLED_HSN_VERSION = '([^']+)'/.exec(loader)![1]!;
    const data = JSON.parse(
      await readFile(join(PATHS.data, `hsn-v${version}.json`), 'utf8'),
    ) as HsnDataFile;
    const codes = new Set(data.rows.map((r) => r.code));
    const sac = [
      '9954',
      '9961',
      '9962',
      '9963',
      '9964',
      '9965',
      '9966',
      '9967',
      '9968',
      '9969',
      '9971',
      '9972',
      '9973',
      '9981',
      '9982',
      '9983',
      '9984',
      '9985',
      '9986',
      '9987',
      '9988',
      '9989',
      '9991',
      '9992',
      '9993',
      '9994',
      '9995',
      '9996',
      '9997',
      '9998',
      '9999',
    ];
    expect(sac.filter((c) => !codes.has(c))).toEqual([]);
    for (const chapter of [
      '04',
      '07',
      '09',
      '10',
      '15',
      '17',
      '22',
      '24',
      '30',
      '33',
      '34',
      '61',
      '62',
      '84',
      '85',
      '87',
      '94',
    ])
      expect(
        [...codes].some((c) => c.startsWith(chapter)),
        `chapter ${chapter}`,
      ).toBe(true);
    expect(data.rows.every((r) => r.effective_from === '2025-09-22' && r.rate_bp >= 0)).toBe(true);
  });
});
