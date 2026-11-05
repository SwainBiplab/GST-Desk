/**
 * Budgets for GSTR-2B reconciliation (prompt 31, NFR): matching 5,000 2B lines against 5,000 bills in
 * under 5 s (the engine alone), then through the database: importing a 5,000-line 2B and opening the
 * reconciliation of a month. PERF_DOCS sets the size of the seeded book (default 5,000; CI uses 50,000).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  monthPeriod,
  parse2bJson,
  reconcile,
  toDecimalString,
  type BookBill,
  type Entry2B,
} from '@gst/domain';

import { migrate } from '../src/migrate';
import { openSqlite } from '../src/node';
import { GstrRepo } from '../src/repositories/gstr';
import { Gstr2bRepo } from '../src/repositories/gstr2b';
import { seedDemo } from '../src/seed';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8')) as {
  reconMatchMs: number;
  reconImportMs: number;
  reconOpenMs: number;
};
const docs = Number(process.env['PERF_DOCS'] ?? 5000);
const LINES = 5000;

const rupees = (p: number) => Number(toDecimalString(BigInt(p), 2));
const supplier = (i: number) => `29AAAAA${String(1000 + (i % 250))}A1Z5`;
const day = (i: number) => String((i % 27) + 1).padStart(2, '0');

const dir = mkdtempSync(join(tmpdir(), 'gst-perf-2b-'));
const file = join(dir, 'perf.sqlite');
try {
  const checks: { name: string; ms: number; budget: number; pass: boolean }[] = [];
  const add = (name: string, ms: number, budget: number) =>
    checks.push({ name, ms: Math.round(ms), budget, pass: ms <= budget });

  // 1. the engine alone: 5,000 lines against 5,000 bills with a realistic mix
  const es: Entry2B[] = [];
  const bs: BookBill[] = [];
  for (let i = 0; i < LINES; i++) {
    const taxable = 100_000 + i * 37;
    es.push({
      id: `e${i}`,
      supplierGstin: supplier(i),
      supplierName: 'S',
      docType: 'invoice',
      number: `INV/${i}`,
      date: `2025-04-${day(i)}`,
      taxable,
      igst: 0,
      cgst: Math.round(taxable * 0.09),
      sgst: Math.round(taxable * 0.09),
      cess: 0,
      itcAvailable: 'Y',
      reason: '',
      supplierPeriod: '',
      period: '042025',
    });
    if (i % 10 === 9) continue; // missing from the books
    bs.push({
      id: `b${i}`,
      supplierGstin: supplier(i),
      number:
        i % 10 === 3
          ? `2025-26/INV/${i}`
          : i % 10 === 5
            ? `INV-${String(i).padStart(6, '0')}`
            : `INV/${i}`,
      date: `2025-04-${day(i)}`,
      type: 'purchase_bill',
      taxable: i % 10 === 7 ? taxable + 50_000 : taxable,
      igst: 0,
      cgst: Math.round(taxable * 0.09),
      sgst: Math.round(taxable * 0.09),
      cess: 0,
    });
  }
  const t0 = performance.now();
  const matches = reconcile(es, bs);
  add(
    `engine: ${LINES} lines against ${bs.length} bills`,
    performance.now() - t0,
    budgets.reconMatchMs,
  );

  // 2. through the database
  const d = await openSqlite(`file:${file}`);
  await migrate(d);
  const { ctx } = await seedDemo(d, { documents: docs, parties: 200, items: 500 });
  const gstr = new GstrRepo(d);
  const repo = new Gstr2bRepo(d);
  const info = await gstr.businessInfo(ctx);
  const period = monthPeriod(info.gstin, 2025, 4);

  const json = JSON.stringify({
    data: {
      gstin: info.gstin,
      rtnprd: '042025',
      docdata: {
        b2b: [...new Set(es.map((e) => e.supplierGstin))].map((ctin) => ({
          ctin,
          trdnm: 'S',
          inv: es
            .filter((e) => e.supplierGstin === ctin)
            .map((e) => ({
              inum: e.number,
              dt: `${e.date.slice(8, 10)}-${e.date.slice(5, 7)}-${e.date.slice(0, 4)}`,
              itcavl: 'Y',
              txval: rupees(e.taxable),
              igst: 0,
              cgst: rupees(e.cgst),
              sgst: rupees(e.sgst),
              cess: 0,
            })),
        })),
      },
    },
  });
  const parsed = parse2bJson(json);
  if (parsed.entries.length !== LINES)
    throw new Error(`parsed ${parsed.entries.length} of ${LINES} lines`);

  const t1 = performance.now();
  await repo.importReturn(ctx, parsed, { source: 'json' });
  add(`import ${LINES} lines`, performance.now() - t1, budgets.reconImportMs);

  const t2 = performance.now();
  const ws = await repo.workspace(ctx, period);
  add(
    `open the reconciliation (${ws.rows.length} rows)`,
    performance.now() - t2,
    budgets.reconOpenMs,
  );

  const t3 = performance.now();
  await repo.importReturn(ctx, parsed, { source: 'json' });
  add(
    `import the same ${LINES} lines again (replaces the month)`,
    performance.now() - t3,
    budgets.reconImportMs,
  );

  await d.close();

  const out = resolve(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db-gstr2b.json'),
    JSON.stringify(
      { suite: 'db-gstr2b', at: new Date().toISOString(), docs, matches: matches.length, checks },
      null,
      2,
    ),
  );
  console.log(`GSTR-2B reconciliation perf (${LINES} lines, ${docs} documents):`);
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
