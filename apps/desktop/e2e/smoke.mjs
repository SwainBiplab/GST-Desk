#!/usr/bin/env node
/**
 * Desktop smoke test, driven through `tauri-driver` (WebDriver) against a DEBUG build.
 *
 *   node apps/desktop/e2e/smoke.mjs --app <path to gst-desk(.exe)> [--driver tauri-driver] [--native msedgedriver]
 *
 * It needs a debug build made with the test update key (see docs/runbooks/desktop-testing.md):
 *   pnpm --filter desktop tauri build --debug --no-bundle --config apps/desktop/e2e/test-config.json
 *
 * What it checks, on the real app with its real Rust database:
 *   1. the app launches and the page loads;
 *   2. the demo business loads (500 documents through the Rust SQLite connection) and the data folder
 *      on disk holds the database;
 *   3. the Desktop settings tab shows that folder, and the printers list renders;
 *   4. an update check against a local mock server finds the newer version;
 *   5. a download whose signature is valid is accepted, and one that was tampered with is refused;
 *   6. a manifest served over the beta channel is read from `beta/latest.json`.
 *
 * It uses only Node's built-in `fetch` and `http`, so it adds no dependency. It exits 1 on failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    app: { type: 'string' },
    driver: { type: 'string', default: 'tauri-driver' },
    native: { type: 'string' },
    port: { type: 'string', default: '4444' },
    fixtures: { type: 'string', default: join(import.meta.dirname, 'fixtures') },
  },
});
if (!a.app || !existsSync(a.app)) {
  console.error('usage: smoke.mjs --app <built gst-desk binary> [--native <msedgedriver>]');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- a mock update server */

const fixtures = a.fixtures;
const file = (n) => readFileSync(join(fixtures, n));
const sig = (n) => readFileSync(join(fixtures, n), 'utf8').trim();
let served = [];
const mock = createServer((req, res) => {
  served.push(req.url);
  const send = (body, type = 'application/json') => {
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };
  const base = `http://127.0.0.1:${mock.address().port}`;
  const manifest = (version, pkg, sigFile) => ({
    version,
    notes: 'Test release',
    pub_date: '2030-01-01T00:00:00Z',
    platforms: Object.fromEntries(
      ['windows-x86_64', 'darwin-x86_64', 'darwin-aarch64', 'linux-x86_64'].map((p) => [
        p,
        { url: `${base}/${pkg}`, signature: sig(sigFile) },
      ]),
    ),
  });
  if (req.url === '/latest.json') return send(JSON.stringify(manifest('99.0.0', 'good.bin', 'good.bin.sig')));
  if (req.url === '/tampered/latest.json') return send(JSON.stringify(manifest('99.0.0', 'tampered.bin', 'good.bin.sig')));
  if (req.url === '/beta/latest.json') return send(JSON.stringify(manifest('99.1.0-beta.1', 'good.bin', 'good.bin.sig')));
  if (req.url === '/good.bin') return send(file('good.bin'), 'application/octet-stream');
  if (req.url === '/tampered.bin') return send(file('tampered.bin'), 'application/octet-stream');
  res.writeHead(404).end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

/* ----------------------------------------------------------- WebDriver, by hand */

const dataDir = mkdtempSync(join(tmpdir(), 'gstdesk-e2e-'));
mkdirSync(dataDir, { recursive: true });
const driverArgs = ['--port', a.port, ...(a.native ? ['--native-driver', a.native] : [])];
const driver = spawn(a.driver, driverArgs, {
  stdio: 'inherit',
  // the app is a child of the driver and inherits this: a scratch folder, never the real data
  env: { ...process.env, GSTDESK_DATA_DIR: dataDir },
});
const base = `http://127.0.0.1:${a.port}`;

async function wd(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok || j.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(j.value ?? j)}`);
  return j.value;
}

let session;
const until = async (what, fn, ms = 60_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
};
const run = (script, ...args) => wd('POST', `/session/${session}/execute/sync`, { script, args });
const runAsync = (script, ...args) => wd('POST', `/session/${session}/execute/async`, { script, args });
const text = (testid) => run(`return document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`);
const goto = (path) => wd('POST', `/session/${session}/url`, { url: `http://tauri.localhost${path}` });
const invoke = (cmd, args) =>
  runAsync(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
       .then((v) => done({ ok: v }), (e) => done({ err: String(e) }));`,
  );

async function main() {
  const created = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: resolve(a.app) } } },
  });
  session = created.sessionId;

  // 1. launch
  await until('the page to load', () => run('return document.readyState === "complete" && !!document.getElementById("root")'));
  check('the app launches and the page loads', true);

  // 2. the demo business through the Rust database
  await goto('/books/dashboard?demo=1');
  await until('500 documents', async () => (await text('badge-documents'))?.trim() === '500', 180_000);
  check('the demo business loads through the Rust database (500 documents)', true);
  const dbFile = join(dataDir, 'data', 'gst-desk.sqlite3');
  check('the database file is in the data folder', existsSync(dbFile) && statSync(dbFile).size > 100_000, dbFile);

  // 3. the desktop tab
  await goto('/books/settings?tab=desktop');
  await until('the desktop tab', async () => !!(await text('data-root')));
  const root = (await text('data-root')).trim();
  check('the Desktop tab shows the data folder', root.replace(/\\/g, '/') === dataDir.replace(/\\/g, '/'), root);
  const printers = await run(`return !!document.querySelector('[data-testid="printer-list"],[data-testid="no-printers"]')`);
  check('the printers list renders', printers === true);

  // 4. an update check against the mock server
  const found = await invoke('update_check', { channel: 'stable', baseUrl: `${mockBase}/latest.json` });
  check('an update check finds the newer version', found.ok?.version === '99.0.0', JSON.stringify(found));

  // 5. a valid signature is accepted, a tampered download is refused
  const good = await invoke('update_download', {});
  check('a download with a valid signature is accepted', good.err === undefined && 'ok' in good, JSON.stringify(good));
  await invoke('update_check', { channel: 'stable', baseUrl: `${mockBase}/tampered/latest.json` });
  const bad = await invoke('update_download', {});
  check('a tampered download is refused', typeof bad.err === 'string', JSON.stringify(bad));

  // 6. the beta channel reads beta/latest.json
  served = [];
  const beta = await invoke('update_check', { channel: 'beta', baseUrl: `${mockBase}/latest.json` });
  check('the beta channel reads the beta manifest', served.includes('/beta/latest.json') && beta.ok?.version === '99.1.0-beta.1', JSON.stringify(beta));
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  check('the run finished without an error', false, e.message);
} finally {
  try {
    if (session) await wd('DELETE', `/session/${session}`);
  } catch {
    /* the app may already be gone */
  }
  driver.kill();
  mock.close();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad} passed, ${bad} failed (data folder: ${dataDir})`);
process.exit(failed || bad ? 1 : 0);
