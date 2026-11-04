# Reports: reviewer sign-off

Scope: the **sales register**, the **HSN summary** (GSTR-1 table 12 preview) and the **documents issued summary** (GSTR-1 table 13 preview), checked against three months of the seeded demo business. Code: `packages/db/src/repositories/reports.ts`, `packages/domain/src/turnover.ts`. The automated tests below prove the reports agree with each other and with the ledger; this sheet is for a chartered accountant to confirm they are what a return needs.

## How to review

1. Settings → load the demo business (Books). Open Reports → Sales register.
2. Choose Custom dates and one of the three months below. Compare with the same month taken straight from the documents list.
3. Do the same for HSN summary and Documents issued. Export CSV and open it in a spreadsheet to check the totals row and that amounts are numbers.
4. Write the result in the table and sign at the bottom.

Months to check (the seed starts on 1 April 2024): **April 2024**, **October 2024** (a month with credit notes and cancelled invoices) and **March 2025** (a financial-year end).

## What the software does

| #   | Rule                                                                                                                                                                      | Test                                                                                                                 | Reviewed |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Turnover counts issued tax invoices, bills of supply and debit notes, and subtracts credit notes. Proformas, quotations and challans never count.                         | `turnover` tests in `packages/domain/test/reports.test.ts`; `reports.test.ts` "counts exactly the issued…"           |          |
| 2   | Drafts and cancelled documents are not in the sales register, and a cancelled document keeps its number in the documents summary.                                         | same; `reports.test.ts` "the document summary counts issued and cancelled numbers per series"                        |          |
| 3   | Sales register total taxable = GST summary (outward) = HSN summary = party-wise = item-wise = the ledger's Sales account, to the paisa.                                   | `reports.test.ts` "sales register = GST summary (outward) = HSN summary = ledger sales" (SQLite and Postgres)        |          |
| 4   | A credit note appears as minus in the sales register, and as its own amounts in the credit and debit note register.                                                       | `reports.test.ts` "the note register lists credit and debit notes…"; `reports.spec.ts` "credit notes show as minus…" |          |
| 5   | HSN summary: one row per HSN or SAC, unit (as the UQC the business reports, custom units mapped, unmapped ones `OTH`) and rate. Credit notes reduce it.                   | `reports.test.ts` (HSN total equals the register); UQC mapping `units` tests                                         |          |
| 6   | Documents issued: per type and series, the first and last number (ordered by serial, not as text), how many were issued including cancelled, and how many were cancelled. | `reports.test.ts` "the document summary counts…" and the serial order check                                          |          |
| 7   | Periods use the Indian financial year (April to March) and Asia/Kolkata dates; "this quarter" is the GST quarter.                                                         | `packages/domain/test/reports.test.ts` "period presets"                                                              |          |
| 8   | Exports hold every row of the filtered report, amounts as numbers in rupees, dates as dates, text never as a formula, and a totals row.                                   | `reports.spec.ts` "exports CSV and Excel…"; `apps/web/src/features/reports/reports.test.ts`                          |          |

## Review results

| Month      | Sales register taxable (software) | Same from the documents list | HSN summary taxable | Documents summary: first, last, cancelled | Differences found |
| ---------- | --------------------------------- | ---------------------------- | ------------------- | ----------------------------------------- | ----------------- |
| April 2024 |                                   |                              |                     |                                           |                   |
| Oct 2024   |                                   |                              |                     |                                           |                   |
| March 2025 |                                   |                              |                     |                                           |                   |

## Open points for the reviewer

1. **HSN summary and the B2B and B2C split.** GSTR-1 table 12 is reported in one table for all outward supplies. This report does not split by B2B and B2C. Confirm that is acceptable for the preview.
2. **Credit notes in the HSN summary.** They reduce the quantity and the value of their HSN. Confirm that matches how table 12 treats them.
3. **GST summary (3B preview).** Inward supplies are all treated as eligible input credit. Ineligible credit, reverse-charge inward supplies and ITC reversals are not separated yet (backlog B-047).
4. **Documents issued.** Counts invoices, bills of supply, debit and credit notes, receipt vouchers and delivery challans. Confirm that is the right list for table 13.

Reviewed by: ______________________ Membership no.: ______________ Date: ______________
