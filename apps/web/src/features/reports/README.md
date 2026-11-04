# features/reports

Reports and the question-led dashboards (prompt 18, FR-070 to FR-073, UX-06). The queries live in `packages/db/src/repositories/reports.ts`; this folder is the page around them.

## What is here

| File               | What it does                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reports-page.tsx` | The report list, and one report at a time. Reads which report from the address.                                                                                                                                                                        |
| `report-view.tsx`  | The shared report page: filter bar, virtualised table that loads pages as it is scrolled, totals row, grouping, column chooser, saved views, CSV and Excel export, print.                                                                              |
| `model.ts`         | No React: the address to state and back, how a cell is shown and exported, grouping with subtotals. Unit tested.                                                                                                                                       |
| `xlsx.ts`          | A small .xlsx writer over `fflate`. Text is always an inline string, so a spreadsheet never runs it as a formula.                                                                                                                                      |
| `hooks.ts`         | `useReportData` (paged query, refreshed when the data under it changes), `useReportExport`, `useSavedViews`, `useDashboard`.                                                                                                                           |
| `dashboard.tsx`    | The Shop and Books dashboard cards. Every number is a button that opens its report with the same filters.                                                                                                                                              |
| `charts.tsx`       | The dashboard charts, drawn as SVG with no chart library: grouped columns, lines, a ranked bar list, a legend, a hover tooltip and a table view of the same numbers. Series colours are `--viz-1` and `--viz-2` in `index.css`, stepped for dark mode. |
| `download.ts`      | Hands a file to the browser.                                                                                                                                                                                                                           |

## Public surface

- Route: `/shop/reports` and `/books/reports`, with `?report=<id>` and the search keys `preset`, `from`, `to`, `party`, `type`, `side`, `book`, `group`, `cols`. Defaults are left out of addresses.
- Command bar: one action per report ("Open report: Sales register"); stock actions only when the business tracks stock.
- Saved views are kept in the `settings` table under `reports.views`.

## Adding a report

1. Add its id to `REPORT_IDS` and an entry to `REPORTS` in `packages/db/src/repositories/reports.ts` (columns, which are summed, which can be grouped, filters, what a row opens).
2. Write its query in the same file and add it to the `switch` in `runReport`. A register takes `page` and returns whole-set totals from an aggregate query; a summary returns every row.
3. Add its title, description and any new column labels under `reports.r.<id>` and `reports.col` in `apps/web/src/lib/i18n.ts`.
4. Add a case to the "every report in the catalogue runs" test and, if it must agree with another report, a reconciliation test.

## Testing

```
pnpm --filter @gst/domain test        # periods, ageing, turnover rules, filing calendar
pnpm --filter @gst/db test            # reports.test.ts: reconciliation on the seed, SQLite and Postgres
pnpm --filter web test                # address state, cell formatting, grouping, CSV and XLSX
pnpm --filter @gst/db perf            # first page of every report and the export on a seeded book (PERF_DOCS=50000)
pnpm --filter web build && pnpm --filter web e2e e2e/reports.spec.ts
```
