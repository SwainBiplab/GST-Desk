# features/gst

The Filing Desk (prompt 30, FR-080, FR-084): prepare GSTR-1 and GSTR-3B from issued documents, check them, export the files, and record when a return was filed. The rules are in `packages/domain/src/gstr/`; the loading and recording are in `packages/db/src/repositories/gstr.ts`; this folder is the screen. Read `docs/decisions/0016-gst-returns.md` first, and note that the file layout is **not verified** against the government's offline tool.

## What is here

| File                                                | What it does                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gst-page.tsx`                                      | One row per period with GSTR-1 and GSTR-3B status, due date and problems; the review below it (GSTR-1 tables, GSTR-3B figures, checks); export, mark filed, reopen; ITC changes.     |
| `model.ts`                                          | No React: the periods shown, a card's status, the table summaries, the export files (JSON, CSV in a ZIP). Unit tested.                                                               |
| `reconcile-tab.tsx`                                 | The GSTR-2B tab: import, tiles, filter by class, a row per result with its actions, accept all, apply to GSTR-3B, link by hand, create a purchase bill, and the matching tolerances. |
| `recon-model.ts`, `recon-file.ts`, `recon-hooks.ts` | Filters and tiles with no React; reading a downloaded file (JSON or Excel) with no React; the live queries and actions.                                                              |
| `xlsx-read.ts`                                      | A small .xlsx reader (text of every cell; nothing in the file is run).                                                                                                               |
| `prefill.ts`                                        | Hands a 2B line to the purchase editor for a minute or two.                                                                                                                          |
| `hooks.ts`                                          | Live queries (filings, the review of a period, adjustments) and the actions a person takes. Only the three newest periods are worked out eagerly; older ones when opened.            |

## Public surface

- Route: `/books/gst` (and `/shop/gst`); command bar: "Go to GST returns".
- Settings used: `gst.filing.kind` (`month` or `quarter`), `gst.recon.options` (the matching tolerances).
- Tables written: `gst_filings`, `gst_adjustments`, `gst_issue_acks`, `gstr2b_imports`, `gstr2b_entries`, `gstr2b_decisions`. Inbox: `prefiling_issue` cards (see `packages/ai`).
- Exports are downloaded as `GSTR1_<GSTIN>_<MMYYYY>.json`, `…_csv.zip` and `GSTR3B_<GSTIN>_<MMYYYY>.json`.

## Rules for changing it

- A tax rule changes in `gstr1.ts` or `gstr3b.ts`, with a worked test case, and is added to `docs/compliance/gstr-review.md`.
- A file-format change changes `packages/domain/data/gstn-schemas/` and a golden file, not the builders.
- Do not convert paise to floating point (a test enforces it).
- No telemetry names were added: the counter allowlist is a privacy decision.

## Problems and acknowledgements (prompt 31)

Export is off while any problem is neither fixed nor acknowledged with a reason, and the database layer re-checks it (`GstrRepo.assertExportable`). Read `docs/decisions/0017-gstr2b-reconciliation-and-prefiling.md` and `docs/compliance/gstr2b-review.md` first: the 2B file layouts are not verified against a real download.
