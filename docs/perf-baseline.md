# Performance baseline

Reference device: 8 GB RAM, 4-core CPU, no GPU.
Web perf tests run in Chrome DevTools with CPU throttled 4x.

## Items and CSV import (prompt 13)

Measured in Chrome with SQLite on OPFS (`pnpm --filter web perf`, `perf/items.perf.ts`), 200 seeded items plus a 10,000-row CSV. The import runs at full speed; grid and command bar timings at 4x CPU throttle.

| Measure                                  | Budget    | Measured |
| ---------------------------------------- | --------- | -------- |
| Review (dry run) of 10,000 rows          | 10 s      | 0.2 s    |
| Import of 10,000 items (one transaction) | 30 s      | 2.4 s    |
| Scroll to the end of the 10,200-row grid | 1 s       | 0.16 s   |
| Grid search among 10,200 items           | 1 s       | 0.12 s   |
| Sort 10,200 items                        | 1.5 s     | 0.22 s   |
| Command bar search among 10,200 items    | 1.5 s     | 0.21 s   |
| Rows in the DOM for the grid             | under 100 | 24       |

Database level (`packages/db`, both dialects, in `items.test.ts`): HSN lookup among 10,000 codes under 50 ms on SQLite FTS5 (150 ms allowed on PGlite, which is Postgres compiled to WebAssembly); 10,000-item import under 30 s.

## Document editor (prompt 14)

Measured in Chrome (`pnpm --filter web perf`, `perf/documents.perf.ts`) with 200 lines pasted into the grid. Keystroke handling is the time from the input event to the end of the resulting task (pricing and React commit; paint excluded).

| Measure                                | Budget | Full speed           | At 4x CPU throttle |
| -------------------------------------- | ------ | -------------------- | ------------------ |
| Keystroke handling, p95, 200 lines     | 16 ms  | 12 ms (median 10 ms) | 89 ms              |
| Preview shows the change after an edit | 300 ms | 271 ms               | not measured       |
| Engine reprices 200 lines              | 20 ms  | about 1 ms           | not measured       |

The 16 ms budget is checked at full speed on the development machine. Preview includes its 150 ms debounce. The engine figure is also asserted in `packages/domain/test/documents.test.ts`.

## Printing (prompt 17)

Measured in Node at full speed (`packages/print/test/pdf.test.ts` and `perf.test.ts` assert the budgets) and in Chrome for the preview (`pnpm --filter web perf`, `perf/documents.perf.ts`). Layout and PDF include loading no fonts (they are cached after the first use).

| Measure                                                        | Budget | Measured (full speed)             | Estimated at 4x CPU |
| -------------------------------------------------------------- | ------ | --------------------------------- | ------------------- |
| One-page invoice PDF, size                                     | 150 KB | 22 KB                             | same                |
| Layout and PDF of a 1-line invoice                             | 2 s    | 215 ms (fonts embedded)           | about 0.9 s         |
| Layout and PDF of a 50-line invoice (4 pages)                  | 2 s    | 250 ms, 57 KB                     | about 1.0 s         |
| Layout and PDF of a 200-line invoice (13 pages)                | n/a    | 350 ms, 170 KB                    | about 1.4 s         |
| Layout alone, 200 lines (what the preview and designer redraw) | 100 ms | 8 ms                              | about 32 ms         |
| Designer or editor preview follows a change, 200 lines         | 300 ms | 228 ms (includes 150 ms debounce) | not measured        |
| Keystroke handling with the new preview open, p95, 200 lines   | 16 ms  | 14 to 15 ms                       | 71 ms               |

The preview redraws only the pages whose content changed and runs at a lower priority than typing (`useDeferredValue`); before that, the keystroke p95 rose to 18 ms. The PDF runs in a Web Worker, so the page does not freeze while it is made.

## Reports and dashboards (prompt 18)

Measured in Node at full speed on a seeded SQLite file of 50,000 documents (about 150,000 lines, 18,000 payments) with `PERF_DOCS=50000 pnpm --filter @gst/db perf` (`perf/reports.perf.ts`). The period is the whole two-year seed, the widest a user would pick; each figure is the median of three runs after a warm-up. Budget for every report: first page under 1 s (NFR-01 and the prompt). A register's first page is 100 rows with the totals of the whole filtered set.

| Report                                  | Rows in the set | First page          |
| --------------------------------------- | --------------- | ------------------- |
| Sales register                          | 29,124          | 168 ms              |
| Purchase register                       | 6,382           | 50 ms               |
| Credit and debit notes                  | 3,397           | 38 ms               |
| Party outstanding                       | 200             | 496 ms              |
| Receivables and payables                | 7               | 450 ms              |
| GST summary by rate                     | 10              | 511 ms              |
| HSN summary                             | 50              | 526 ms              |
| Documents issued                        | 5               | 342 ms              |
| Expense summary                         | 500             | 40 ms               |
| Receipts and payments                   | 18,002          | 45 ms               |
| Day book                                | 54,821          | 352 ms              |
| Stock summary                           | 450             | 131 ms              |
| Party-wise sales and purchases          | 200             | 146 ms              |
| Item-wise sales                         | 500             | 412 ms              |
| Export of the sales register (all rows) | 29,124          | 1.4 s (budget 10 s) |
| Dashboard, every number in one read     |                 | about 0.8 s         |

The line-level reports (HSN, GST summary, item-wise) read every line of the period and are the slowest; the first measurement of HSN was 0.9 s before its description came from the item master instead of from each line. The browser's SQLite on OPFS is slower than Node's; the report page shows how long each report took beside its row count. Writing a 50,000-row workbook takes about 1 s (`apps/web/src/features/reports/reports.test.ts`).
