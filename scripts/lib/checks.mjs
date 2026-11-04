/**
 * Release verification checks. Each returns `{ name, ok, detail }` so the CLI can print a checklist.
 * Side effects (spawning processes, running migrations) are injected so the checks are unit-testable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { verifyMinisign } from './minisign.mjs';

const result = (name, ok, detail) => ({ name, ok, detail });

/** Magic numbers by bundle extension. `null` = no fixed header to check. */
const MAGIC = {
  '.appimage': Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  '.exe': Buffer.from('MZ'),
  '.msi': Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), // OLE compound file
  '.deb': Buffer.from('!<arch>\n'),
  '.gz': Buffer.from([0x1f, 0x8b]),
  '.dmg': null,
};

export const BUNDLE_EXTENSIONS = Object.keys(MAGIC);

/** All installer bundles under `dir` (recursive). */
export function findBundles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => BUNDLE_EXTENSIONS.includes(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

/** Installer sizes must stay under the NFR-09 budget (default 15 MB). */
export function checkInstallerSizes(bundles, maxBytes = 15 * 1024 * 1024) {
  if (bundles.length === 0) return [result('installer size', false, 'no bundles found')];
  return bundles.map((b) => {
    const size = statSync(b).size;
    const mb = (size / 1024 / 1024).toFixed(2);
    return result(
      `installer size: ${basename(b)}`,
      size <= maxBytes,
      `${mb} MB (limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB)`,
    );
  });
}

/** Static "will it start" check: the file is non-empty and has the right executable header. */
export function checkBundleHeaders(bundles) {
  return bundles.map((b) => {
    const ext = extname(b).toLowerCase();
    const size = statSync(b).size;
    if (size === 0) return result(`bundle header: ${basename(b)}`, false, 'file is empty');
    const magic = MAGIC[ext];
    if (!magic)
      return result(`bundle header: ${basename(b)}`, true, 'no fixed header for this type');
    const head = readFileSync(b).subarray(0, magic.length);
    return result(
      `bundle header: ${basename(b)}`,
      head.equals(magic),
      head.equals(magic) ? 'header ok' : `unexpected header ${head.toString('hex')}`,
    );
  });
}

/**
 * Optional smoke run: start `command` and require it to exit 0 within the timeout, or still be running
 * (a desktop app that stays up counts as started). `spawn` is injected: (cmd, args, timeoutMs) => Promise<{code, timedOut}>.
 */
export async function checkStarts(command, spawn, timeoutMs = 5000) {
  if (!command) return [result('bundle starts', true, 'skipped (no --smoke-cmd given)')];
  const [cmd, ...args] = command.split(' ');
  try {
    const r = await spawn(cmd, args, timeoutMs);
    const ok = r.timedOut || r.code === 0;
    return [
      result(
        'bundle starts',
        ok,
        r.timedOut ? 'still running after timeout' : `exit code ${r.code}`,
      ),
    ];
  } catch (e) {
    return [result('bundle starts', false, e.message)];
  }
}

/** Run the current migrations against a database created by the previous release. */
export async function checkMigration(previousDb, runMigration) {
  if (!previousDb)
    return [result('migration from previous version', true, 'skipped (no --previous-db given)')];
  if (!existsSync(previousDb))
    return [result('migration from previous version', false, `${previousDb} not found`)];
  try {
    const r = await runMigration(previousDb);
    return [
      result(
        'migration from previous version',
        r.ok === true,
        r.ok
          ? `schema version ${r.version}, ${r.applied} migration(s) applied`
          : String(r.error ?? 'migration failed'),
      ),
    ];
  } catch (e) {
    return [result('migration from previous version', false, e.message)];
  }
}

/** Manifest shape, version match, and a verified signature for every platform entry. */
export function checkManifest({ manifestPath, bundleDir, pubkey, expectedVersion }) {
  const out = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return [result('updater manifest', false, `cannot read ${manifestPath}: ${e.message}`)];
  }
  const entries = Object.entries(manifest.platforms ?? {});
  out.push(
    result(
      'updater manifest shape',
      typeof manifest.version === 'string' && entries.length > 0 && !!manifest.pub_date,
      `version ${manifest.version}, ${entries.length} platform(s)`,
    ),
  );
  if (expectedVersion) {
    out.push(
      result(
        'manifest version',
        manifest.version === expectedVersion,
        `${manifest.version} (expected ${expectedVersion})`,
      ),
    );
  }
  for (const [platform, entry] of entries) {
    const file = decodeURIComponent(basename(new URL(entry.url).pathname));
    const path = findFile(bundleDir, file);
    if (!path) {
      out.push(result(`signature: ${platform}`, false, `${file} not found in ${bundleDir}`));
      continue;
    }
    const v = verifyMinisign(readFileSync(path), entry.signature, pubkey);
    out.push(result(`signature: ${platform}`, v.ok, v.ok ? `${file} verified` : v.reason));
  }
  return out;
}

function findFile(dir, name) {
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (basename(f) === name) return join(dir, f);
  }
  return null;
}

export function formatChecklist(results) {
  const lines = results.map((r) => `${r.ok ? '[x]' : '[ ]'} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    '',
    failed === 0
      ? 'Release verification passed.'
      : `Release verification FAILED (${failed} check(s)).`,
  );
  return lines.join('\n');
}
