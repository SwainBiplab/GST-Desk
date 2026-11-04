#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { syncVersions } from './lib/version.mjs';

const desktop = resolve(import.meta.dirname, '..', 'apps', 'desktop');
const version = syncVersions({
  packageJson: join(desktop, 'package.json'),
  tauriConf: join(desktop, 'src-tauri', 'tauri.conf.json'),
  cargoToml: join(desktop, 'src-tauri', 'Cargo.toml'),
});
console.log(`synced desktop version ${version}`);
