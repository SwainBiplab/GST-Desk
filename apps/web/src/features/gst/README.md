# features/gst

The Filing Desk (prompt 30, FR-080, FR-084): prepare GSTR-1 and GSTR-3B from issued documents, check them, export the files, and record when a return was filed. The rules are in `packages/domain/src/gstr/`; the loading and recording are in `packages/db/src/repositories/gstr.ts`; this folder is the screen. Read `docs/decisions/0016-gst-returns.md` first, and note that the file layout is **not verified** against the government's offline tool.

## What is here

| File           | What it does                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gst-page.tsx` | One row per period with GSTR-1 and GSTR-3B status, due date and problems; the review below it (GSTR-1 tables, GSTR-3B figures, checks); export, mark filed, reopen; ITC changes. |
| `model.ts`     | No React: the periods shown, a card's status, the table summaries, the export files (JSON, CSV in a ZIP). Unit tested.                                                           |
| `hooks.ts`     | Live queries (filings, the review of a period, adjustments) and the actions a person takes. Only the three newest periods are worked out eagerly; older ones when opened.        |

## Public surface

- Route: `/books/gst` (and `/shop/gst`); command bar: "Go to GST returns".
- Settings used: `gst.filing.kind` (`month` or `quarter`).
- Tables written: `gst_filings`, `gst_adjustments`. Inbox: `prefiling_issue` cards (see `packages/ai`).
- Exports are downloaded as `GSTR1_<GSTIN>_<MMYYYY>.json`, `…_csv.zip` and `GSTR3B_<GSTIN>_<MMYYYY>.json`.

## Rules for changing it

- A tax rule changes in `gstr1.ts` or `gstr3b.ts`, with a worked test case, and is added to `docs/compliance/gstr-review.md`.
- A file-format change changes `packages/domain/data/gstn-schemas/` and a golden file, not the builders.
- Do not convert paise to floating point (a test enforces it).
- No telemetry names were added: the counter allowlist is a privacy decision.
