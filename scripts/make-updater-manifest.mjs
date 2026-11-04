#!/usr/bin/env node
/**
 * Write the Tauri updater manifest.
 *
 *   node scripts/make-updater-manifest.mjs --version 1.2.3 --dir bundles --base-url https://updates.example.com/gst-desk \
 *     [--notes "Fixes"] [--out latest.json]
 *
 * `--base-url` (or env UPDATE_BASE_URL) is where the bundles will be hosted.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { buildManifest } from './lib/manifest.mjs';

const { values: a } = parseArgs({
  options: {
    version: { type: 'string' },
    dir: { type: 'string' },
    'base-url': { type: 'string' },
    notes: { type: 'string', default: '' },
    out: { type: 'string', default: 'latest.json' },
  },
});

const baseUrl = a['base-url'] ?? process.env.UPDATE_BASE_URL;
if (!a.version || !a.dir || !baseUrl) {
  console.error(
    'usage: make-updater-manifest.mjs --version <semver> --dir <bundles> --base-url <url> [--notes ..] [--out latest.json]',
  );
  process.exit(2);
}

const manifest = buildManifest({ version: a.version, notes: a.notes, baseUrl, dir: a.dir });
writeFileSync(a.out, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `wrote ${a.out}: ${a.version}, platforms: ${Object.keys(manifest.platforms).join(', ')}`,
);
