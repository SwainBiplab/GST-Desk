#!/usr/bin/env node
/**
 * Makes everything the desktop smoke test needs that must not be committed: a throw-away update
 * signing key, a "release" file signed with it, a copy of that file with one byte changed, and the
 * config that gives the test build the matching public key.
 *
 *   node apps/desktop/e2e/make-fixtures.mjs
 *
 * Output goes to apps/desktop/e2e/.generated (ignored by git). The key signs only these test files.
 * It has nothing to do with the real release key (docs/runbooks/signing.md).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = join(here, '.generated');
const fixtures = join(out, 'fixtures');
const desktop = join(here, '..');
rmSync(out, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });

function tauri(...args) {
  const r = spawnSync('pnpm', ['exec', 'tauri', ...args], { cwd: desktop, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`tauri ${args.join(' ')} failed`);
  }
  return r.stdout;
}

const key = join(out, 'test.key');
const PASSWORD = 'test-only-not-a-secret';
tauri('signer', 'generate', '--ci', '-w', key, '-p', PASSWORD);
const pubkey = readFileSync(`${key}.pub`, 'utf8').trim();

const good = join(fixtures, 'good.bin');
writeFileSync(good, Buffer.from('GST Desk test release ' + 'x'.repeat(4000)));
tauri('signer', 'sign', '-f', key, '-p', PASSWORD, good);
// the signature file sits beside the file as good.bin.sig
const tampered = join(fixtures, 'tampered.bin');
copyFileSync(good, tampered);
const bytes = readFileSync(tampered);
bytes[10] ^= 1;
writeFileSync(tampered, bytes);

// the test build trusts the test key and reads updates from a placeholder address (the test passes the real mock address)
const config = {
  bundle: { createUpdaterArtifacts: false },
  plugins: { updater: { pubkey, endpoints: ['http://127.0.0.1:9/latest.json'] } },
};
writeFileSync(join(out, 'test-config.json'), JSON.stringify(config, null, 2));
console.log(`fixtures written to ${fixtures}\nconfig: ${join(out, 'test-config.json')}`);
