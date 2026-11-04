/** Tauri updater manifest (`latest.json`) builder. */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Which bundle file the updater should download for each platform key, and how to recognise it.
 * Tauri v2 updater artifacts: AppImage (linux), NSIS exe (windows), app.tar.gz (macOS).
 */
export const PLATFORM_ARTIFACTS = [
  { platform: 'linux-x86_64', match: /\.AppImage$/ },
  { platform: 'windows-x86_64', match: /-setup\.exe$/ },
  { platform: 'darwin-x86_64', match: /\.app\.tar\.gz$/ },
  { platform: 'darwin-aarch64', match: /\.app\.tar\.gz$/ },
];

/**
 * @param {object} o
 * @param {string} o.version semver without leading v
 * @param {string} o.notes release notes
 * @param {string} o.baseUrl update URL prefix, no trailing slash
 * @param {string} o.dir directory containing the bundles and their `.sig` files
 * @param {string} [o.pubDate] ISO timestamp (injected so output is reproducible)
 */
export function buildManifest({ version, notes, baseUrl, dir, pubDate }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`bad version "${version}"`);
  const files = listFiles(dir);
  const platforms = {};
  for (const { platform, match } of PLATFORM_ARTIFACTS) {
    const file = files.find((f) => match.test(f) && files.includes(`${f}.sig`));
    if (!file) continue;
    platforms[platform] = {
      signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
      url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(basename(file))}`,
    };
  }
  if (Object.keys(platforms).length === 0)
    throw new Error(`no signed updater bundles found in ${dir}`);
  return { version, notes, pub_date: pubDate ?? new Date().toISOString(), platforms };
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: false }).map(String);
}
