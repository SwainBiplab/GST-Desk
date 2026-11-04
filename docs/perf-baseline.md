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
