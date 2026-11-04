/** Keep the Tauri app and Cargo crate versions in step with apps/desktop/package.json. */
import { readFileSync, writeFileSync } from 'node:fs';

export function setCargoVersion(toml, version) {
  // only the [package] table's version, not dependency versions
  const start = toml.indexOf('[package]');
  if (start < 0) throw new Error('no [package] table in Cargo.toml');
  const next = toml.indexOf('\n[', start + 1);
  const end = next < 0 ? toml.length : next;
  const pkg = toml.slice(start, end);
  if (!/^version\s*=\s*"[^"]*"/m.test(pkg)) throw new Error('no version in [package]');
  return (
    toml.slice(0, start) +
    pkg.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`) +
    toml.slice(end)
  );
}

export function setTauriVersion(json, version) {
  const c = JSON.parse(json);
  c.version = version;
  return JSON.stringify(c, null, 2) + '\n';
}

export function syncVersions({ packageJson, tauriConf, cargoToml }) {
  const { version } = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`bad version "${version}"`);
  writeFileSync(tauriConf, setTauriVersion(readFileSync(tauriConf, 'utf8'), version));
  writeFileSync(cargoToml, setCargoVersion(readFileSync(cargoToml, 'utf8'), version));
  return version;
}
