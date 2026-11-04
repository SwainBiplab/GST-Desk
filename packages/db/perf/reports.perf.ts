/**
 * DB-side budgets for reports (prompt 18, NFR-01) on a seeded SQLite file: the first page of every
 * report, and the export of every row of the sales register. PERF_DOCS sets the size (default
 * 5,000 locally; CI uses 50,000).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from '../src/migrate';
import { openSqlite } from '../src/node';
import {
  REPORTS,
  REPORT_IDS,
  exportReport,
  getDashboard,
  runReport,
  type ReportParams,
} from '../src/repositories/reports';
import { seedDemo } from '../src/seed';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8')) as {
  reportFirstPageMs: number;
  reportExportMs: number;
  dashboardMs: number;
};
const docs = Number(process.env['PERF_DOCS'] ?? 5000);

const dir = mkdtempSync(join(tmpdir(), 'gst-perf-reports-'));
const file = join(dir, 'perf.sqlite');
try {
  const d = await openSqlite(`file:${file}`);
  await migrate(d);
  const t0 = performance.now();
  const { ctx } = await seedDemo(d, { documents: docs, parties: 200, items: 500 });
  const seedMs = Math.round(performance.now() - t0);
  // the whole two-year seed, as the widest period a user would pick
  const params: ReportParams = { from: '2024-04-01', to: '2026-03-31', today: '2026-03-31' };

  const checks: { name: string; ms: number; budget: number; pass: boolean }[] = [];
  const add = (name: string, ms: number, budget: number) =>
    checks.push({ name, ms: Math.round(ms), budget, pass: ms <= budget });

  /** The median of a few runs after one to warm up: one slow run on a busy machine is not the report. */
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

  for (const id of REPORT_IDS) {
    const page = REPORTS[id].paged ? { offset: 0, limit: 100 } : undefined;
    const r = await runReport(d, ctx, id, params, page);
    const ms = await median(() => runReport(d, ctx, id, params, page));
    add(`${id}, first page (${r.count} rows)`, ms, budgets.reportFirstPageMs);
  }

  const s = performance.now();
  const sent = await exportReport(d, ctx, 'sales_register', params, () => {});
  add(`sales register export (${sent} rows)`, performance.now() - s, budgets.reportExportMs);

  add(
    'dashboard, every number',
    await median(() => getDashboard(d, ctx, '2026-03-31')),
    budgets.dashboardMs,
  );
  await d.close();

  const out = resolve(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db-reports.json'),
    JSON.stringify(
      { suite: 'db-reports', at: new Date().toISOString(), docs, seedMs, checks },
      null,
      2,
    ),
  );
  console.log(`report perf at ${docs} documents (seeded in ${seedMs} ms):`);
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
