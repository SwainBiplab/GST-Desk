# TDS, TCS and income tax estimate: reviewer sign-off

**Status: NOT SIGNED.** The rules were written by Claude (an AI assistant) from the Income-tax Act 1961 and the Finance Acts of 2024 and 2025 as known on 2026-11-05. No chartered accountant has checked the rates, thresholds or section codes, and the CSV layouts have not been tried in the return-preparation utility. The Income-tax Act 2025 takes effect on 1 April 2026 and renumbers these sections; the sections below are the 1961 Act's. Every screen says "confirm with your CA". Do not file a statement from these files until this sheet is signed and the utility check below is done.

Rules live in `packages/domain/data/direct-tax.json`. Vectors live in `packages/domain/test/direct-tax.test.ts`. Names below match the test names.

| #   | Rule                            | Behaviour                                                                                                                                             | Proving test                                                                  | Reviewed |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| 1   | 194C contractors                | 1% individual or HUF, 2% others; tax if one payment is over INR 30,000 or the year exceeds INR 1 lakh; on crossing, everything not yet taxed          | "194C single payment...", "194C year total crosses...", "catch-up leaves out" |          |
| 2   | 194J professional and technical | 10% professional, 2% technical service; threshold INR 30,000, INR 50,000 from 1 April 2025                                                            | "194J ..." cases                                                              |          |
| 3   | 194H commission                 | 5%, 2% from 1 October 2024; threshold INR 15,000, INR 20,000 from 1 April 2025                                                                        | "194H ..." cases                                                              |          |
| 4   | 194I rent                       | 2% plant and machinery, 10% land, building, furniture; threshold INR 2.4 lakh, INR 6 lakh from 1 April 2025; on crossing, the year to date            | "194I(a)", "194I(b)"                                                          |          |
| 5   | 194Q purchase of goods          | 0.1% on the part of the year's purchases above INR 50 lakh; only for a buyer whose previous year turnover exceeded INR 10 crore                       | "194Q ...", "skips 194Q for a buyer under INR 10 crore"                       |          |
| 6   | No PAN, s.206AA                 | Higher of the rate and 20%; 194Q 5%                                                                                                                   | "charges 20% when the payee has no PAN..."                                    |          |
| 7   | Lower certificate, s.197        | Certificate rate inside its dates and up to its limit, ordinary rate on the rest; ignored without a PAN                                               | "uses a lower-deduction certificate..."                                       |          |
| 8   | Rounding, s.288B                | TDS and TCS to the nearest rupee                                                                                                                      | "rounds the tax to the nearest rupee"                                         |          |
| 9   | TCS 206C(1) and (1F)            | Liquor 1%, timber 2.5%, forest produce 2.5%, tendu leaves 5%, scrap 1%, minerals 1%, motor vehicle above INR 10 lakh 1%; no PAN: twice the rate or 5% | "TCS" cases                                                                   |          |
| 9a  | TCS 206C(1H)                    | 0.1% on the part above INR 50 lakh; ended 31 March 2025 (Finance Act 2025)                                                                            | "206C(1H) taxes only the part above..."                                       |          |
| 10  | Deposit due dates               | 7th of the next month; 30 April for March                                                                                                             | "gives the deposit and statement due dates"                                   |          |
| 11  | Statement due dates             | Q1 31 July, Q2 31 October, Q3 31 January, Q4 31 May                                                                                                   | same                                                                          |          |
| 12  | Quarters                        | April to June, July to September, October to December, January to March                                                                               | "puts each date in its quarter..."                                            |          |
| 13  | 26Q and 27EQ annexure           | One row per deduction with PAN, party code (company 01), section or nature code, amounts, challan                                                     | "writes the annexure and the challan summary as CSV (layout snapshot)"        |          |
| 14  | Challan checks                  | Unmatched deduction, short challan, late deposit, unused challan, missing PAN                                                                         | "raises a problem for..."                                                     |          |
| 15  | Slabs, new regime 2025-26       | 0 to 4 lakh nil, 5%, 10%, 15%, 20%, 25% above 24 lakh 30%                                                                                             | "computes new-regime slab tax by hand"                                        |          |
| 16  | Slabs, old regime               | 2.5 lakh nil (3 lakh senior, 5 lakh super senior), 5%, 20% above 5 lakh, 30% above 10 lakh                                                            | "computes old-regime slab tax by hand"                                        |          |
| 17  | Rebate, s.87A                   | New: nil up to INR 12 lakh, with marginal relief above; old: up to INR 5 lakh, INR 12,500                                                             | "applies the rebate...", "gives marginal relief just above INR 12 lakh"       |          |
| 18  | Surcharge and cess              | 10%, 15%, 25% (37% old regime above INR 5 crore) with marginal relief; cess 4%                                                                        | "adds surcharge, with marginal relief just over INR 50 lakh"                  |          |
| 19  | Old-regime deductions           | 80C 1.5 lakh, 80CCD(1B) 50,000, 80D 25,000 (50,000 senior; parents separately), home loan interest 2 lakh                                             | "caps old-regime deductions at their limits..."                               |          |
| 20  | Presumptive 44AD and 44ADA      | 44AD 8% (6% received digitally); limit INR 2 crore, INR 3 crore if cash is 5% or less; 44ADA 50%, limit INR 50 lakh, INR 75 lakh                      | "works out presumptive income..."                                             |          |
| 21  | Advance tax                     | 15%, 45%, 75%, 100% by 15 June, 15 September, 15 December, 15 March; presumptive: all by 15 March; none under INR 10,000                              | "lists the instalments...", "charges nothing below INR 10,000..."             |          |
| 22  | Interest 234B and 234C          | 234B 1% a month if less than 90% paid by 31 March; 234C 1% a month on each shortfall (relaxed 12% and 36% for the first two); shortfalls to INR 100   | "charges 234B and 234C when nothing was paid" and the cases beside it         |          |

## Open points for the reviewer

1. **Sections not covered.** 194A (interest), 194D, 194M, 194N, 194O, 194R and 194S are not in the data. Add what the business pays.
2. **194C thresholds.** The aggregate threshold of INR 1 lakh is applied to the year's payments to one payee under this section. Confirm that catch-up of earlier payments on the crossing payment is the intended reading.
3. **194J(a) and 194J(b).** The software offers "professional" (10%) and "technical" (2%). Royalty for films and other 194J(b) limbs are not separated.
4. **194Q turnover test.** The previous year's turnover comes from issued sales in the books. When the business has no history the test is skipped and 194Q applies.
5. **FY 2026-27 slabs** are assumed to be those of 2025-26. Confirm against the Finance Act 2026 and the Income-tax Act 2025.
6. **TDS credited to the proprietor.** The estimate takes one amount for TDS and TCS credit; it does not check it against the TDS receivable register or Form 26AS.
7. **Presumptive income** gives no warning that declaring less than the presumptive rate needs a books audit.
8. **Interest 234A** (late return) and tax paid after 31 March are not modelled.

## Checks that need a real file or tool (not decidable by judgement)

| Check                                                                                             | Done | Notes |
| ------------------------------------------------------------------------------------------------- | ---- | ----- |
| The 26Q CSV and the 27EQ CSV import into the return-preparation utility without error             |      |       |
| The section codes and nature codes match the utility's drop-down lists                            |      |       |
| A seeded quarter's challan matching agrees with a deposit receipt (OLTAS) printed from the portal |      |       |

Reviewed by: ______________________ Membership no.: ______________ Date: ______________
