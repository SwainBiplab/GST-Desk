---
'@gst/domain': minor
'@gst/db': minor
'@gst/ai': patch
'@gst/i18n': minor
'web': minor
---

GSTR-2B reconciliation and pre-filing checks (prompt 31). Import a GSTR-2B from the portal's JSON or the Excel download, and every line is matched with a purchase bill: matched, matched with differences (the fields are listed), in 2B but not in the books, in the books but not in 2B, or a duplicate in the books; what is unmatched is carried into the next three months. Accept matches in bulk, link a stray line by hand, mark a supplier to file, ignore a line, or create a purchase bill from a 2B line. Tiles show credit per 2B, per the books, eligible, to defer and to reverse, and applying the outcome adjusts GSTR-3B table 4 (replacing the last time it was applied). The matching tolerances are settings. 5,000 lines against 5,000 bills match in under 100 ms. New checks (duplicate invoices, supply type against place of supply, HSN length, rate against the HSN list, credit note larger than its invoice, cancelled documents with payments, dates out of order) join the existing ones, and export stays off until each problem is fixed or acknowledged with a reason, which is audited and can be taken back. A purchase bill marked not eligible for credit now claims none in GSTR-3B. **The 2B file layouts have not been tried on a real download and no chartered accountant has validated the classification** (`docs/compliance/gstr2b-review.md`, ADR 0017). Following the review decisions recorded in those sheets: amounts match within INR 1 by default, credit blocked under section 17(5) is shown in 4A and reversed in 4B(1), table 4D carries its current labels, reverse-charge 2B lines are left out and counted, and the HSN digit rule follows last year's turnover.
