# Performance results: GST returns (prompt 30)

Procedure: `packages/db/perf/gstr.perf.ts` (`PERF_DOCS=50000 pnpm --filter @gst/db exec tsx perf/gstr.perf.ts`), on the seeded demo book at **50,000 documents**, SQLite, the Windows 11 development laptop (not the reference laptop). The prompt names no budget; the budgets below are ours (`packages/db/perf/budgets.json`). Each figure is the median of three runs after one warm-up. Raw numbers: `perf-results/db-gstr.json`.

| What                                                                                                 | Result | Budget | Status |
| ---------------------------------------------------------------------------------------------------- | ------ | ------ | ------ |
| One month: load every document and line, build GSTR-1 and GSTR-3B, run every check (1,596 documents) | 99 ms  | 2 s    | Met    |
| One quarter, the same (4,634 documents)                                                              | 325 ms | 5 s    | Met    |
| Write the GSTR-1 JSON of that month                                                                  | 3 ms   | 2 s    | Met    |

Not measured: the screen in a browser at 4x CPU throttle (the Filing Desk works out only the three newest periods on opening and the rest when opened), and the reference laptop. A month with many more lines per document than the seed would take longer in proportion to the number of lines.
