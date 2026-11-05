/**
 * DB-side budgets for GST returns (prompt 30) on a seeded SQLite file: working out both returns for
 * one month (every document and line of it loaded, GSTR-1 and GSTR-3B built, every check run) and for
 * a quarter, then writing the GSTR-1 JSON. PERF_DOCS sets the size (default 5,000; CI uses 50,000).
 * The budgets are ours (the prompt names none): 2 s for a month, 5 s for a quarter.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { gstr1Json, monthPeriod, quarterPeriod } from '@gst/domain';

import { migrate } from '../src/migrate';
import { openSqlite } from '../src/node';
import { GstrRepo } from '../src/repositories/gstr';
import { seedDemo } from '../src/seed';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8')) as {
  gstrReviewMs: number;
  gstrQuarterMs: number;
};
const docs = Number(process.env['PERF_DOCS'] ?? 5000);

const dir = mkdtempSync(join(tmpdir(), 'gst-perf-gstr-'));
const file = join(dir, 'perf.sqlite');
try {
  const d = await openSqlite(`file:${file}`);
  await migrate(d);
  const t0 = performance.now();
  const { ctx } = await seedDemo(d, { documents: docs, parties: 200, items: 500 });
  const seedMs = Math.round(performance.now() - t0);
  const repo = new GstrRepo(d);
  const info = await repo.businessInfo(ctx);
  const gstin = info.gstin || '27AAPFU0939F1ZV';

  const checks: { name: string; ms: number; budget: number; pass: boolean }[] = [];
  const add = (name: string, ms: number, budget: number) =>
    checks.push({ name, ms: Math.round(ms), budget, pass: ms <= budget });
  async function median(fn: () => Promise<unknown>, runs = 3): Promise<number> {
    await fn();
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      await fn();
      xs.push(performance.now() - s);
    }
    return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  }

  const month = monthPeriod(gstin, 2025, 3);
  const loaded = await repo.loadDocs(ctx, month.from, month.to);
  add(
    `one month, both returns and every check (${loaded.length} documents)`,
    await median(() => repo.review(ctx, month)),
    budgets.gstrReviewMs,
  );
  const quarter = quarterPeriod(gstin, 2025, 3);
  const q = await repo.loadDocs(ctx, quarter.from, quarter.to);
  add(
    `one quarter, both returns and every check (${q.length} documents)`,
    await median(() => repo.review(ctx, quarter), 2),
    budgets.gstrQuarterMs,
  );
  const review = await repo.review(ctx, month);
  add(
    'GSTR-1 JSON of that month',
    await median(async () => JSON.stringify(gstr1Json(review.gstr1))),
    budgets.gstrReviewMs,
  );
  await d.close();

  const out = resolve(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db-gstr.json'),
    JSON.stringify(
      { suite: 'db-gstr', at: new Date().toISOString(), docs, seedMs, checks },
      null,
      2,
    ),
  );
  console.log(`GST return perf at ${docs} documents (seeded in ${seedMs} ms):`);
  for (const c of checks)
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.ms} ms (budget ${c.budget} ms)`);
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes a locked file */
  }
}
