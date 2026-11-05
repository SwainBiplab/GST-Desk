# 0019 — TDS, TCS and income tax

Status: accepted. Context: prompt 33, PRD FR-100, FR-101, CR-06.

## Decision

- **Rules are data.** Every rate, threshold, effective date, section code and slab is in `packages/domain/data/direct-tax.json`, loaded with a JSON import attribute so Node, Vite and Playwright all read it. The code states no rate. A test checks the limits in rupees a person can recognise, because a crore is 10^9 paise and that is easy to get wrong. The file carries `verified: false` and every screen and report says so.
- **Pure engine, recorded truth.** `computeTds` and `computeTcs` take the amount, the payee's PAN, the year's position and return a deduction with a trace. What was actually deducted or collected is a row in `tax_deductions`. The software suggests; a person accepts. A deduction is never recorded silently, because a deductor can lawfully deduct differently (a certificate, a mistake already corrected) and the return must match what was deposited.
- **Thresholds are computed, not cached in a table.** The year's position per party and section is read from issued documents and recorded deductions in one query each time. Live queries refetch when `documents`, `parties` or `tax_deductions` change, which is the "cached, recomputed on change" the prompt asks for without a second copy that can drift.
- **Catch-up.** When a year's total crosses a threshold (194C aggregate, 194J, 194H, 194I), tax is deducted on everything not yet taxed, so earlier payments are caught up on the payment that crosses. 194Q and 206C(1H) tax only the part above the limit. `alreadyBasePaise` carries what has been taxed so far.
- **Base is without GST** where the section says so (circulars 23/2017 and 13/2021); 206C(1H) was on the receipt including GST (circular 17/2020) and ended on 31 March 2025.
- **No PAN** raises the rate (s.206AA: the higher of the rate and 20%, 5% for 194Q; s.206CC for TCS). A lower-deduction certificate (s.197) applies only inside its dates and up to its limit, and not to a party with no PAN.
- **Rounding.** TDS and TCS round to the nearest rupee (s.288B); taxable income rounds down to ten rupees (s.288A) and income tax to the nearest ten rupees.
- **Tables.** `tax_deductions`, `tax_challans`, `tds_receivable`, and the party columns for PAN kind, section, category, service kind, TCS nature and a lower certificate. Guards (no hard delete, row-level security) are in migration `9006_extras_tax`. Removal is a move to the trash with the audit log keeping it.
- **Challans map to deductions** by `challan_id`. A statement flags a deduction with no challan, a challan that deposited less than it was matched to, a late deposit and an unused challan.
- **Statements.** 26Q and 27EQ annexures, the challan summary and the data for Form 16A and 27D are built from plain records in `packages/domain/src/direct-tax/reports.ts`, as CSV and Excel. The headings follow the return-preparation utility's annexures as documented and are **not verified** against the utility.
- **Income tax** is an estimate for a proprietor: net profit from the ledger or presumptive income under 44AD or 44ADA, old and new regime side by side, advance tax dates, and interest under 234B and 234C. Inputs are kept per business and year in settings. Losses brought forward, capital gains and anything not listed are out of scope and the screen says so.
- **FY 2026-27 slabs are assumed unchanged** from 2025-26 (`sameAs`) and the estimate says so until the Finance Act 2026 and the Income-tax Act 2025 are checked.

## Consequences

- A change in the law is an edit to one JSON file and a test vector, not a release of logic.
- 206C(1H) cannot be suggested from invoices (it is on receipts and ended in March 2025), so it is entered by hand through the form, which uses the same engine.
- The Hindi screens for this page are machine drafts marked for review; the other four languages are drafts too.
