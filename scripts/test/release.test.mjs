import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkBundleHeaders,
  checkInstallerSizes,
  checkManifest,
  checkMigration,
  checkStarts,
  findBundles,
  formatChecklist,
} from '../lib/checks.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import {
  makeMinisignFixture,
  parsePublicKey,
  parseSignature,
  verifyMinisign,
} from '../lib/minisign.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
const PE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(60)]);

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKeyRaw: der.subarray(der.length - 32), keyId: randomBytes(8) };
}

function signed(file, kp = keypair(), algorithm = 'ED') {
  return { kp, ...makeMinisignFixture({ ...kp, fileBytes: file, algorithm }) };
}

describe('minisign', () => {
  it('verifies a Tauri-style signature (prehashed ED) and the raw variant (Ed)', () => {
    const file = randomBytes(2048);
    for (const alg of ['ED', 'Ed']) {
      const s = signed(file, keypair(), alg);
      expect(verifyMinisign(file, s.signature, s.pubkey)).toEqual({ ok: true });
    }
  });

  it('rejects a tampered file, another key, and a tampered trusted comment', () => {
    const file = randomBytes(512);
    const s = signed(file);
    const tampered = Buffer.from(file);
    tampered[0] ^= 1;
    expect(verifyMinisign(tampered, s.signature, s.pubkey)).toMatchObject({
      ok: false,
      reason: /does not match the file/,
    });
    const other = signed(file);
    expect(verifyMinisign(file, s.signature, other.pubkey)).toMatchObject({
      ok: false,
      reason: /different key/,
    });
    const text = Buffer.from(s.signature, 'base64').toString().replace('file:test', 'file:evil');
    expect(verifyMinisign(file, Buffer.from(text).toString('base64'), s.pubkey)).toMatchObject({
      ok: false,
      reason: /trusted comment/,
    });
  });

  it('never throws on garbage input', () => {
    expect(verifyMinisign(Buffer.alloc(1), 'not base64!!', 'nope')).toMatchObject({ ok: false });
    const s = signed(Buffer.alloc(4));
    expect(verifyMinisign(Buffer.alloc(4), 'AAAA', s.pubkey)).toMatchObject({
      ok: false,
      reason: /not a minisign signature/,
    });
    expect(() => parsePublicKey('AAAA')).toThrow();
    expect(() => parseSignature('AAAA')).toThrow();
  });
});

describe('installer checks', () => {
  function bundle(name, bytes) {
    writeFileSync(join(dir, name), bytes);
    return join(dir, name);
  }

  it('finds bundles recursively by extension', () => {
    mkdirSync(join(dir, 'appimage'));
    writeFileSync(join(dir, 'appimage', 'GST Desk.AppImage'), ELF);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'GST_x64-setup.exe'), PE);
    expect(
      findBundles(dir)
        .map((f) => f.split(/[\\/]/).pop())
        .sort(),
    ).toEqual(['GST Desk.AppImage', 'GST_x64-setup.exe']);
  });

  it('enforces the size budget', () => {
    const small = bundle('small.AppImage', ELF);
    const big = bundle('big.deb', Buffer.alloc(2 * 1024 * 1024));
    const r = checkInstallerSizes([small, big], 1024 * 1024);
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    expect(r[1].detail).toMatch(/2\.00 MB/);
    expect(checkInstallerSizes([])).toEqual([
      { name: 'installer size', ok: false, detail: 'no bundles found' },
    ]);
  });

  it('checks executable headers and rejects empty or wrong files', () => {
    const good = [
      bundle('a.AppImage', ELF),
      bundle('b.exe', PE),
      bundle('c.dmg', Buffer.from('anything')),
      bundle('d.msi', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0])),
      bundle('e.deb', Buffer.from('!<arch>\nxx')),
    ];
    expect(checkBundleHeaders(good).every((c) => c.ok)).toBe(true);
    const bad = [
      bundle('f.AppImage', Buffer.from('#!/bin/sh\n')),
      bundle('g.exe', Buffer.alloc(0)),
    ];
    const r = checkBundleHeaders(bad);
    expect(r.map((c) => c.ok)).toEqual([false, false]);
    expect(r[1].detail).toMatch(/empty/);
  });

  it('smoke-start accepts exit 0 or a running process and rejects failures', async () => {
    expect((await checkStarts(undefined, async () => ({})))[0]).toMatchObject({
      ok: true,
      detail: /skipped/,
    });
    expect(
      (await checkStarts('app --version', async () => ({ code: 0, timedOut: false })))[0].ok,
    ).toBe(true);
    expect((await checkStarts('app', async () => ({ code: null, timedOut: true })))[0].ok).toBe(
      true,
    );
    expect((await checkStarts('app', async () => ({ code: 3, timedOut: false })))[0].ok).toBe(
      false,
    );
    expect(
      (await checkStarts('app', async () => Promise.reject(new Error('ENOENT'))))[0],
    ).toMatchObject({ ok: false, detail: 'ENOENT' });
  });
});

describe('migration check', () => {
  it('skips without a database, fails when missing, and reports the runner result', async () => {
    expect((await checkMigration(undefined, async () => ({})))[0]).toMatchObject({
      ok: true,
      detail: /skipped/,
    });
    expect((await checkMigration(join(dir, 'nope.sqlite'), async () => ({})))[0]).toMatchObject({
      ok: false,
      detail: /not found/,
    });
    const db = join(dir, 'prev.sqlite');
    writeFileSync(db, 'x');
    expect(
      (await checkMigration(db, async () => ({ ok: true, version: 2, applied: 1 })))[0],
    ).toMatchObject({ ok: true, detail: 'schema version 2, 1 migration(s) applied' });
    expect((await checkMigration(db, async () => ({ ok: false, error: 'boom' })))[0]).toMatchObject(
      { ok: false, detail: 'boom' },
    );
    expect(
      (await checkMigration(db, async () => Promise.reject(new Error('crash'))))[0],
    ).toMatchObject({ ok: false, detail: 'crash' });
  });
});

describe('updater manifest', () => {
  function release(version = '1.2.3') {
    const kp = keypair();
    const appimage = Buffer.concat([ELF, randomBytes(100)]);
    const nsis = Buffer.concat([PE, randomBytes(100)]);
    const a = makeMinisignFixture({ ...kp, fileBytes: appimage });
    const n = makeMinisignFixture({ ...kp, fileBytes: nsis });
    writeFileSync(join(dir, 'GST Desk_1.2.3_amd64.AppImage'), appimage);
    writeFileSync(join(dir, 'GST Desk_1.2.3_amd64.AppImage.sig'), a.signature);
    writeFileSync(join(dir, 'GST Desk_1.2.3_x64-setup.exe'), nsis);
    writeFileSync(join(dir, 'GST Desk_1.2.3_x64-setup.exe.sig'), n.signature);
    const manifest = buildManifest({
      version,
      notes: 'n',
      baseUrl: 'https://u.example/gst/',
      dir,
      pubDate: '2026-01-01T00:00:00Z',
    });
    const manifestPath = join(dir, 'latest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return { manifest, manifestPath, pubkey: a.pubkey };
  }

  it('builds a manifest with signed platform entries and encoded URLs', () => {
    const { manifest } = release();
    expect(Object.keys(manifest.platforms).sort()).toEqual(['linux-x86_64', 'windows-x86_64']);
    expect(manifest.platforms['linux-x86_64'].url).toBe(
      'https://u.example/gst/GST%20Desk_1.2.3_amd64.AppImage',
    );
    expect(manifest.pub_date).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects bad versions and empty directories', () => {
    expect(() => buildManifest({ version: 'v1', notes: '', baseUrl: 'x', dir })).toThrow(
      /bad version/,
    );
    expect(() => buildManifest({ version: '1.0.0', notes: '', baseUrl: 'https://x', dir })).toThrow(
      /no signed/,
    );
  });

  it('verifies every signature', () => {
    const { manifestPath, pubkey } = release();
    const r = checkManifest({ manifestPath, bundleDir: dir, pubkey, expectedVersion: '1.2.3' });
    expect(
      r.every((c) => c.ok),
      JSON.stringify(r),
    ).toBe(true);
    expect(r.map((c) => c.name)).toEqual([
      'updater manifest shape',
      'manifest version',
      'signature: linux-x86_64',
      'signature: windows-x86_64',
    ]);
  });

  it('fails on a swapped bundle, wrong key, wrong version and missing file', () => {
    const { manifestPath, pubkey } = release();
    writeFileSync(
      join(dir, 'GST Desk_1.2.3_amd64.AppImage'),
      Buffer.concat([ELF, randomBytes(100)]),
    );
    const swapped = checkManifest({ manifestPath, bundleDir: dir, pubkey });
    expect(swapped.find((c) => c.name === 'signature: linux-x86_64')).toMatchObject({
      ok: false,
      detail: /does not match/,
    });
    expect(swapped.find((c) => c.name === 'signature: windows-x86_64').ok).toBe(true);

    const otherKey = makeMinisignFixture({ ...keypair(), fileBytes: Buffer.alloc(1) }).pubkey;
    expect(
      checkManifest({ manifestPath, bundleDir: dir, pubkey: otherKey }).some((c) => !c.ok),
    ).toBe(true);
    expect(
      checkManifest({ manifestPath, bundleDir: dir, pubkey, expectedVersion: '9.9.9' }).find(
        (c) => c.name === 'manifest version',
      ).ok,
    ).toBe(false);

    rmSync(join(dir, 'GST Desk_1.2.3_x64-setup.exe'));
    expect(
      checkManifest({ manifestPath, bundleDir: dir, pubkey }).find(
        (c) => c.name === 'signature: windows-x86_64',
      ),
    ).toMatchObject({ ok: false, detail: /not found/ });
    expect(
      checkManifest({ manifestPath: join(dir, 'missing.json'), bundleDir: dir, pubkey })[0].ok,
    ).toBe(false);
  });
});

describe('checklist', () => {
  it('marks passes and failures and summarises', () => {
    const text = formatChecklist([
      { name: 'a', ok: true, detail: 'fine' },
      { name: 'b', ok: false, detail: 'broken' },
    ]);
    expect(text).toContain('[x] a: fine');
    expect(text).toContain('[ ] b: broken');
    expect(text).toContain('FAILED (1 check(s))');
    expect(formatChecklist([{ name: 'a', ok: true, detail: '' }])).toContain('passed');
  });
});
