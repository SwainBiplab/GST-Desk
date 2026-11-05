# 0016 — GST returns (GSTR-1 and GSTR-3B): where the rules live, and what is not claimed

Status: accepted. Context: prompt 30, `phase-2/30-gstr1-gstr3b-export.md`. Review sheet: `docs/compliance/gstr-review.md` (unsigned).

## Decisions

### 1. The arithmetic is pure domain code; the database only loads and records

`packages/domain/src/gstr/` takes plain documents (`GstrDoc`) and returns typed tables: no database, no React, no clock. `GstrRepo` (`packages/db/src/repositories/gstr.ts`) reads a period's documents and lines into that shape and stores the person's actions. This keeps the rules testable by hand (every table has a worked case in `packages/domain/test/gstr.test.ts`) and lets the screen, the export and the inbox check all go through one function, `reviewPeriod`.

### 2. The government's file layout is data, applied last

The table builders know nothing about key names. `json.ts` writes the offline-tool layout using codes and limits from `packages/domain/data/gstn-schemas/v1.ts`, so a layout change is a data change plus a golden file. See that folder's README for adding a version.

### 3. The layout is reconstructed, and is labelled as not verified

The GST Network does not publish a downloadable schema for these files; the layout comes from public documentation of the offline tool. `v1.ts` says `verified: false`, the screen carries a note, and `docs/compliance/gstr-review.md` makes loading an export into the real offline tool a required step before filing (backlog B-098). The golden files prove the output is stable, not that the government's tool accepts it. This is the single largest open risk of this prompt.

### 4. Money never goes through floating point

A repository-wide test forbids converting paise with `Number`, `Math.round` or `toFixed`. The files need decimal numbers, so amounts are formatted by integer arithmetic into an exact decimal string (`toDecimalString`) and only then read as a JSON number.

### 5. Credit can be adjusted, never silently

ITC comes from purchase bills and is treated as eligible. Reversals and ineligible amounts are **adjustments** a person enters (`gst_adjustments`), each with a reason, audited like every other row. There is no per-bill eligibility flag yet (B-100).

### 6. Filing state is recorded by a person, not inferred

`gst_filings` holds, per return and period: exported (with the layout version), filed (with the ARN and date), and an optional due-date override. The app does not file anything; "filed" means a person said they filed on the portal. Exporting after filing never moves a return back. Filing can offer to lock the books up to the period end (the existing period lock).

### 7. Problems become inbox cards

`runTier0` raises one `prefiling_issue` card per problem for last month and this month (a business with no GSTIN, or a composition business, gets none). A fixed problem closes its card by itself. Accepting only acknowledges.

### 8. The dashboard's calendar and the Filing Desk share one set of due dates

`filingCalendar` (dashboard) now reads the same rules as the Filing Desk.

## Not done (stated, not hidden)

- Amendments (9A, 9C, 10), advances (AT, ATADJ), deemed exports, e-commerce, imports and ISD, interest and late fee: B-099, B-100.
- Exports are downloaded; saving them under `Documents/GST Desk/<Business>/GST/<Period>/` on the desktop needs a native command: B-101.
- Problem messages are English sentences from the domain package: B-102.
- The seeded book has no exports, SEZ supplies or nil lines, so the database-level reconciliation does not cover them; the domain tests do: B-103.
- No chartered accountant has reviewed any rule, and due-date extensions are not in the data: B-097, B-098.

## Consequences

- A return can be prepared, checked and exported, but must not be filed with these files until the offline-tool check and the CA sign-off are recorded.
- The tax rules live in one place. A rule change is a change to `gstr1.ts` or `gstr3b.ts` with a new test case, reviewed against the sheet above.
