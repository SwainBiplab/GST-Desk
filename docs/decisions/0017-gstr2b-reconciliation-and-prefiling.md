# 0017 — GSTR-2B reconciliation and pre-filing checks

Status: accepted. Context: prompt 31, `phase-2/31-gstr2b-reconciliation-prefiling.md`. Review sheet: `docs/compliance/gstr2b-review.md` (unsigned). Builds on ADR 0016.

## Decisions

### 1. The matching engine is pure, grouped by supplier, and deterministic

`packages/domain/src/reconcile/match.ts` takes lines and bills and returns a class for every one of them, with no database and no clock. Work is grouped by supplier GSTIN, and the looser pass looks only at bills whose number ends in the same digits, so 5,000 lines against 4,500 bills take 88 ms (budget 5 s). Inputs are sorted before matching, so the same data in any order gives the same answer (a test shuffles them).

### 2. A looser match is a match with a difference, never a silent match

Numbers written differently (a year or branch added, zeros padded) match only when the digits agree, the date is within a window and the taxable value is within the tolerance, and the result is `matched_with_differences` with `number` listed, so a person sees it. The tolerances are the business's own settings (3 days, 45 days, INR 1 and no percentage by default: see decision 11).

### 3. Zeros are stripped per part of a number

`GST/2025-26/00045` and `GST/2025-26/45` must be the same: suppliers pad the running number, not the year in front of it. Stripping leading zeros only at the start of the whole number missed this, which a test found.

### 4. The supplier's own invoice number and date are what is compared

The editor keeps them in the purchase bill's details; our own bill number is only a fallback. Reverse-charge bills and bills from suppliers with no GSTIN are not in the reconciliation, because their credit does not come from 2B.

### 5. Decisions are kept against a key that survives a re-import

Accept, link by hand, supplier to file and ignore are kept against `GSTIN | comparable number | type` (or the bill's id), not against the imported row, because importing a month again replaces its rows. A re-import is one transaction: a failure leaves the old import in place.

### 6. The outcome becomes adjustments to GSTR-3B table 4, replaceable

Deferred, duplicate, not-available and excess credit are written as period adjustments with source `reconcile`. Applying again removes the earlier rows of that source and writes new ones; adjustments a person made by hand have no source and are never touched. Every row carries its reason and is audited.

### 7. A bill marked not eligible claims no credit (a correction to prompt 30)

The editor already has an "ITC eligible" checkbox, stored in the bill's details. Prompt 30's GSTR-3B treated every purchase bill as eligible, and its backlog note said no such flag existed; both were wrong. GSTR-3B now reports such a bill's credit in 4A and reverses it in 4B(1) (Circular 170/02/2022-GST; see decision 11), and the reconciliation counts none of its credit as claimed.

### 8. Export is blocked until every problem is fixed or acknowledged, and the database layer enforces it

All checks produce a problem with a stable key. A person acknowledges it with a reason (audited, reversible), and the export asks `GstrRepo.assertExportable`, which works the period out again, so a stale screen cannot export. Problems of one cause are one problem: the HSN-and-rate check lists the documents and its key is the HSN and rate, so an acknowledgement still covers it when more documents join. Problems also appear as inbox cards with the same keys.

### 9. Prefill, not auto-create

"Create purchase bill" from a 2B line adds the supplier as a party if the business does not have them (said in a message), and opens a purchase bill with the supplier, their invoice number and date, and one line for the taxable value at the rate the tax implies. The person adds the HSN and issues it. Nothing is issued for them.

### 10. The guards of the new tables are a new migration

`9000_extras_v1` must stay valid on a database upgraded from the Phase 0 schema, so it was frozen to the tables it covered; the GST tables are in `9003` and the reconciliation tables in `9004`.

### 11. The reviewer's open points were decided (2026-11-05)

At the owner's request, Claude took the open review points in the reviewer's role; the reasoning and basis are in the two review sheets. What changed in the software: amounts match within INR 1 with no percentage by default; blocked credit is in 4A and reversed in 4B(1); table 4D is labelled as in force since July 2022; reverse-charge 2B lines are left out of the import and counted; the HSN digit rule follows last year's turnover. These are not a chartered accountant's sign-off; the signature lines stay blank.

## Not done (stated, not hidden)

- **No real 2B file has been imported**, and no chartered accountant has validated the classification. The file layouts are reconstructed (B-104, B-105). This is the acceptance criterion of the prompt and it is open.
- 2B amendments, ISD, import of goods and e-commerce sections are not imported; pulling 2B from the portal is prompt 32 (B-106).
- The Tier 2 explanation hook exists (`explainWith`) and nothing is wired to it (B-107).
- A book bill cannot yet be linked to a 2B line from the book's row (B-108).
- Problem and explanation text from the domain is English; the screen translates the reconciliation explanations and class names, not the check messages (B-102).

## Consequences

- The reconciliation can be used and its outcome applied, but a person should check its classification against the portal for the first months, and must not rely on it as a substitute for the accountant's review.
- The demo book's GST rates are random, so every month shows HSN-rate warnings; acknowledging them is how the flow is demonstrated.
