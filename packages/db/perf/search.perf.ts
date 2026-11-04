/**
 * DB-side budgets for NFR-01 on a seeded SQLite file: first page of the invoice list and
 * full-text search. PERF_DOCS controls the size (default 5,000 locally; CI uses 50,000).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openSqlite } from '../src/database';
import { migrate } from '../src/migrate';
import { DocumentRepo, PartyRepo } from '../src/repositories/aggregates';
import { seedDemo } from '../src/seed';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8')) as {
  listFirstPageMs: number;
  searchMs: number;
  p: number;
};
const docs = Number(process.env['PERF_DOCS'] ?? 5000);

const dir = mkdtempSync(join(tmpdir(), 'gst-perf-'));
const file = join(dir, 'perf.sqlite');
try {
  const d = await openSqlite(`file:${file}`);
  await migrate(d);
  const t0 = performance.now();
  const { ctx } = await seedDemo(d, { documents: docs, parties: 200, items: 500 });
  const seedMs = Math.round(performance.now() - t0);

  const percentile = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
  async function time(fn: () => Promise<unknown>, runs = 30) {
    await fn(); // warm up
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      await fn();
      xs.push(performance.now() - s);
    }
    return Math.round(percentile(xs, budgets.p));
  }

  const documents = new DocumentRepo(d);
  const parties = new PartyRepo(d);
  const listMs = await time(() =>
    documents.listBy(ctx, { type: 'tax_invoice', status: 'issued', limit: 50 }),
  );
  const docSearchMs = await time(() => documents.search(ctx, 'sharma'));
  const partySearchMs = await time(() => parties.search(ctx, 'patel'));
  await d.close();

  const checks = [
    { name: 'invoice list, first 50 rows', ms: listMs, budget: budgets.listFirstPageMs },
    { name: 'document search', ms: docSearchMs, budget: budgets.searchMs },
    { name: 'party search', ms: partySearchMs, budget: budgets.searchMs },
  ].map((c) => ({ ...c, pass: c.ms <= c.budget }));

  const out = resolve(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db.json'),
    JSON.stringify(
      { suite: 'db', at: new Date().toISOString(), docs, seedMs, percentile: budgets.p, checks },
      null,
      2,
    ),
  );
  console.log(`db perf at ${docs} documents (seeded in ${seedMs} ms, p${budgets.p}):`);
  for (const c of checks)
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.ms} ms (budget ${c.budget} ms)`);
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may keep the file locked briefly; the OS temp cleaner takes it */
  }
}
