/**
 * Backup and restore speed on a seeded SQLite file (prompt 20): how long a backup of a big book takes,
 * how long a restore takes, and the longest the event loop is held without giving the page room to
 * run (what the UI would feel as a freeze). PERF_DOCS sets the size (default 5,000; CI uses 50,000).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createBackup, restoreAll } from '../src/backup';
import { migrate } from '../src/migrate';
import { openNodeSqlite } from '../src/node-sqlite';
import { seedDemo } from '../src/seed';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8')) as {
  backupMs: number;
  restoreMs: number;
  backupBlockMs: number;
  restoreBlockMs: number;
};
const docs = Number(process.env['PERF_DOCS'] ?? 5000);

const dir = mkdtempSync(join(tmpdir(), 'gst-perf-backup-'));
const file = join(dir, 'perf.sqlite');
try {
  const d = await openNodeSqlite(file);
  await migrate(d);
  const seedStart = performance.now();
  await seedDemo(d, { documents: docs, parties: 200, items: 500 });
  const seedMs = Math.round(performance.now() - seedStart);
  const fileMb = Math.round(statSync(file).size / 1e6);

  // the longest stretch between two chances for the page to run
  let last = performance.now();
  let longest = 0;
  const yieldToUi = async () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    await new Promise<void>((r) => setTimeout(r, 0));
    last = performance.now();
  };

  const t0 = performance.now();
  last = t0;
  const { bytes, manifest } = await createBackup(d, { yieldToUi });
  const backupMs = Math.round(performance.now() - t0);
  const backupBlock = Math.round(longest);
  await d.close();

  const fresh = await openNodeSqlite(join(dir, 'restored.sqlite'));
  await migrate(fresh);
  longest = 0;
  const t1 = performance.now();
  last = t1;
  await restoreAll(fresh, bytes, { yieldToUi });
  const restoreMs = Math.round(performance.now() - t1);
  const restoreBlock = Math.round(longest);
  await fresh.close();

  const checks = [
    { name: `backup of ${manifest.totals.rows} rows`, ms: backupMs, budget: budgets.backupMs },
    { name: 'restore into an empty database', ms: restoreMs, budget: budgets.restoreMs },
    {
      name: 'longest stretch without yielding, backup',
      ms: backupBlock,
      budget: budgets.backupBlockMs,
    },
    {
      name: 'longest stretch without yielding, restore',
      ms: restoreBlock,
      budget: budgets.restoreBlockMs,
    },
  ].map((c) => ({ ...c, pass: c.ms <= c.budget }));

  const out = resolve(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db-backup.json'),
    JSON.stringify(
      {
        suite: 'db-backup',
        at: new Date().toISOString(),
        docs,
        seedMs,
        databaseMb: fileMb,
        backupMb: +(bytes.length / 1e6).toFixed(1),
        checks,
      },
      null,
      2,
    ),
  );
  console.log(
    `backup perf at ${docs} documents (database ${fileMb} MB, backup ${(bytes.length / 1e6).toFixed(1)} MB, seeded in ${seedMs} ms):`,
  );
  for (const c of checks)
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.ms} ms (budget ${c.budget} ms)`);
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may keep a file locked briefly; the OS temp cleaner takes it */
  }
}
