/**
 * Bundle the server for the image: one ESM file with every workspace package (`@gst/*`) inside and
 * every published dependency left external (they are installed by `pnpm deploy`). Native modules and
 * worker-thread libraries stay external that way, so nothing is broken by bundling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const external = Object.entries(pkg.dependencies)
  .filter(([, v]) => !String(v).startsWith('workspace:'))
  .map(([k]) => k);
// dynamic imports inside the shared packages that the API never takes (browser and PGlite openers)
external.push('@electric-sql/pglite', '@libsql/client', '@sqlite.org/sqlite-wasm', '@tauri-apps/api');

await build({
  entryPoints: [join(here, '..', 'src', 'main.ts')],
  outfile: join(here, '..', 'dist', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  sourcemap: 'inline',
  logLevel: 'info',
  banner: {
    // esbuild's ESM output needs `require` for a few CommonJS corners of the dependencies
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
