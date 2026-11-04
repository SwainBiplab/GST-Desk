#!/usr/bin/env node
/**
 * Verify a built release before it is published.
 *
 *   node scripts/verify-release.mjs --bundle-dir dist-bundles --manifest latest.json \
 *     --pubkey "$(cat updater.pub)" [--previous-db prev.sqlite] [--smoke-cmd "./app --version"] [--version 1.2.3]
 *
 * Checks: bundles have valid headers and start (optional smoke command), installers are under 15 MB,
 * migrations run on a database from the previous release, and every updater signature verifies.
 * Prints a checklist; exits 1 if anything fails.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  checkBundleHeaders,
  checkInstallerSizes,
  checkManifest,
  checkMigration,
  checkStarts,
  findBundles,
  formatChecklist,
} from './lib/checks.mjs';

const { values: a } = parseArgs({
  options: {
    'bundle-dir': { type: 'string' },
    manifest: { type: 'string' },
    pubkey: { type: 'string' },
    'pubkey-file': { type: 'string' },
    'previous-db': { type: 'string' },
    'smoke-cmd': { type: 'string' },
    version: { type: 'string' },
    'max-mb': { type: 'string', default: '15' },
  },
});

if (!a['bundle-dir']) {
  console.error(
    'usage: verify-release.mjs --bundle-dir <dir> [--manifest latest.json --pubkey <b64>] [--previous-db <file>]',
  );
  process.exit(2);
}

const bundleDir = resolve(a['bundle-dir']);
const root = resolve(import.meta.dirname, '..');

function run(cmd, args, timeoutMs) {
  return new Promise((res, rej) => {
    const child = nodeSpawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      res({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      res({ code, timedOut: false });
    });
  });
}

/** Runs packages/db/scripts/check-migrate.ts and parses its JSON line. */
async function runMigration(dbFile) {
  const r = spawnSync(
    'pnpm',
    ['--filter', '@gst/db', 'exec', 'tsx', 'scripts/check-migrate.ts', resolve(dbFile)],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  const line = r.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: (r.stderr || r.stdout || 'no output').trim().slice(0, 300) };
  }
}

const bundles = existsSync(bundleDir) ? findBundles(bundleDir) : [];
const results = [
  ...checkInstallerSizes(bundles, Number(a['max-mb']) * 1024 * 1024),
  ...checkBundleHeaders(bundles),
  ...(await checkStarts(a['smoke-cmd'], run)),
  ...(await checkMigration(a['previous-db'], runMigration)),
];

if (a.manifest) {
  const pubkey =
    a.pubkey ?? (a['pubkey-file'] ? readFileSync(a['pubkey-file'], 'utf8') : undefined);
  if (!pubkey) {
    results.push({ name: 'updater manifest', ok: false, detail: 'pass --pubkey or --pubkey-file' });
  } else {
    results.push(
      ...checkManifest({
        manifestPath: resolve(a.manifest),
        bundleDir,
        pubkey,
        ...(a.version ? { expectedVersion: a.version } : {}),
      }),
    );
  }
} else {
  results.push({ name: 'updater manifest', ok: true, detail: 'skipped (no --manifest given)' });
}

console.log(formatChecklist(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
