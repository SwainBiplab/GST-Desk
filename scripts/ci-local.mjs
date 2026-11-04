#!/usr/bin/env node
/**
 * Run the same stages as .github/workflows/ci.yml, using the same pnpm scripts, and print a summary.
 *   pnpm ci:local            all stages
 *   pnpm ci:local static e2e only the named stages
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Stage name -> pnpm scripts, mirroring the jobs in ci.yml. */
export const STAGES = {
  static: ['ci:static', 'ci:audit'],
  test: ['ci:test'],
  e2e: ['ci:e2e'],
  bundle: ['ci:storybook', 'ci:size'],
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(STAGES);
for (const n of names) {
  if (!STAGES[n]) {
    console.error(`unknown stage "${n}". Stages: ${Object.keys(STAGES).join(', ')}`);
    process.exit(2);
  }
}

const results = [];
for (const name of names) {
  for (const script of STAGES[name]) {
    const started = Date.now();
    console.log(`\n=== ${name}: pnpm ${script} ===`);
    const r = spawnSync('pnpm', [script], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    results.push({
      name,
      script,
      ok: r.status === 0,
      secs: Math.round((Date.now() - started) / 1000),
    });
    if (r.status !== 0) break;
  }
  if (results.some((r) => !r.ok)) break;
}

console.log('\n--- ci:local summary ---');
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.script.padEnd(14)} ${r.secs}s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
