# GSTR-1 and GSTR-3B: reviewer sign-off

**Status: NOT SIGNED.** Nothing here has been reviewed by a chartered accountant, and the export files have **not** been opened in the GST offline tool. Do not file a real return with these exports until this sheet is signed and the offline-tool check below is recorded. The app says so on the Filing Desk screen.

Scope: GSTR-1 tables 4, 5, 6, 7, 8, 9B, 12 and 13, and GSTR-3B tables 3.1, 3.2, 4, 5 and 6.1 (estimate), built from issued documents. Code: `packages/domain/src/gstr/`, `packages/db/src/repositories/gstr.ts`, `apps/web/src/features/gst/`. File layouts and due dates are data in `packages/domain/data/gstn-schemas/`.

## What must be checked first: the file layout

The GST Network does not publish a downloadable schema for these upload files. The key names, codes and limits in `data/gstn-schemas/v1.ts` were reconstructed from the layout documented for the offline tool and returns, and the file says `verified: false`. They are checked automatically only against **themselves** (`checkGstr1Json`, golden files in `packages/domain/test/gstr/fixtures/`), which proves the output is stable, not that the government's tool accepts it.

**Offline-tool check (required, not yet done):**

1. Load the demo business, open GST returns, review **October 2024**, and export the GSTR-1 JSON.
2. In the GST offline tool, import the JSON for the same period. Record whether it opens without errors and whether each table's totals match the screen.
3. Do the same with the GSTR-3B JSON if the tool supports importing it.
4. Anything the tool rejects is fixed in `data/gstn-schemas/v1.ts` (never by editing the builders), with a new golden file. Then set `verified: true` and record who checked and when below.

| Check                               | Result | Tool version | Date | By  |
| ----------------------------------- | ------ | ------------ | ---- | --- |
| GSTR-1 JSON imports without errors  |        |              |      |     |
| Table totals match the screen       |        |              |      |     |
| GSTR-3B JSON imports (if supported) |        |              |      |     |
| CSV files open in the offline tool  |        |              |      |     |

## What the software does

| #   | Rule                                                                                                                                                                                                                                                                                                                          | Test                                                                                                     | Reviewed |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Only issued documents count. Drafts never do; cancelled documents are in table 13 as cancelled and in no other table.                                                                                                                                                                                                         | `gstr.test.ts` "counts documents per series, including cancelled ones"                                   |          |
| 2   | A supply to a registered buyer (or an SEZ unit) with taxable lines goes to B2B with invoice type R, SEWP (SEZ, tax paid) or SEWOP (SEZ, under LUT). Reverse charge is a flag on the invoice.                                                                                                                                  | "puts a regular invoice…", "handles exports…and SEZ supplies"                                            |          |
| 3   | An inter-state supply to an unregistered buyer goes to **B2CL** when the invoice value is **above INR 1,00,000** (a stored limit, changed from INR 2,50,000 from 1 August 2024); everything else to an unregistered buyer is summed in **B2CS** by place of supply and rate. The test is on invoice value, not taxable value. | "sends a large inter-state sale…", "tests the B2CL limit on the invoice value"                           |          |
| 4   | Exports are in table 6A (with payment, WPAY, or without, WOPAY, by the LUT flag).                                                                                                                                                                                                                                             | "handles exports with and without payment"                                                               |          |
| 5   | Credit and debit notes: to a registered buyer → CDNR; to an unregistered buyer → CDNUR only when the **original invoice** was B2CL (or an export), otherwise they adjust B2CS; the original invoice's value decides.                                                                                                          | "puts notes in CDNR, CDNUR or nets them against B2CS"                                                    |          |
| 6   | Nil-rated, exempt and non-GST lines are in table 8 only (inter/intra, registered/unregistered), never in the tax tables. A nil, exempt or non-GST line of an export or SEZ supply has no table in GSTR-1; it is shown as a warning, not dropped.                                                                              | "reports exempt, nil-rated and non-GST lines in table 8…", "keeps unreportable export nil lines visible" |          |
| 7   | HSN (12) is split into a B2B table and a B2C table by buyer type, one row per HSN, unit (UQC) and rate; credit notes reduce it; non-GST lines are left out.                                                                                                                                                                   | "splits the HSN summary into B2B and B2C…"                                                               |          |
| 8   | Table 13: one range per document nature and series, with total, cancelled and net issued; a gap in the numbers is a warning.                                                                                                                                                                                                  | "counts documents per series…", "keeps separate ranges…"                                                 |          |
| 9   | GSTR-3B 3.1(a) outward taxable, (b) exports and SEZ, (c) nil and exempt, (d) inward reverse charge (purchase bills marked reverse charge, net of returns), (e) non-GST; 3.2 by place of supply; table 5 from exempt, nil and non-GST purchases.                                                                               | `gstr.test.ts` "fills tables 3.1, 3.2, 4 and 5…"                                                         |          |
| 10  | Table 4 ITC: tax on purchase bills (less returns) is treated as eligible; reversals and ineligible amounts are entered by a person as adjustments, each kept with a reason in the audit trail.                                                                                                                                | "applies ITC adjustments…"; `gstr.test.ts` (db) "keeps ITC adjustments"                                  |          |
| 11  | Table 6.1 is an **estimate**: reverse-charge tax is paid in cash; the rest is set off with credit in the order IGST credit → IGST, CGST, SGST; CGST credit → CGST, IGST; SGST credit → SGST, IGST; cess only against cess.                                                                                                    | "estimates payment…"                                                                                     |          |
| 12  | Totals of GSTR-1 equal the GST summary report to the paisa for every month of the seeded book, SQLite and Postgres; HSN equals the HSN summary; GSTR-1 and GSTR-3B agree on outward taxable value and tax.                                                                                                                    | `packages/db/src/repositories/gstr.test.ts`                                                              |          |
| 13  | Checks that block ("problems"): invalid own or recipient GSTIN, missing place of supply or HSN, document number format (up to 16 letters, digits, "/" and "-"), negative taxable value, tables that do not add up. Warnings: short HSN, gaps in numbering.                                                                    | "validation" tests                                                                                       |          |
| 14  | Due dates: GSTR-1 on the 11th and GSTR-3B on the 20th of the next month; quarterly filers (QRMP) GSTR-1 on the 13th and GSTR-3B on the 22nd or 24th by state group. Government extensions are **not** in the data; a person can set a date.                                                                                   | "computes the standard due dates"                                                                        |          |

## Not built yet (so not in the files)

Amendments (tables 9A, 9C, 10) for documents revised after a filed period; advances received and adjusted (AT, ATADJ); deemed exports and e-commerce sections; imports (IMPG, IMPS), input service distributor and per-bill blocked-credit flags in table 4 (adjustments only); interest and late fee (3B 5.1); GSTR-3B 3.1.1; composition returns (CMP-08, GSTR-4). Backlog B-099, B-100.

## Open points for the reviewer

1. **Confirm the B2CL limit and effective date** in the stored data, and that the test should be on the invoice value including tax.
2. **Notes to unregistered buyers**: confirm that a credit note on a small inter-state or intra-state consumer sale should reduce B2CS (as built) rather than be listed.
3. **HSN digits**: the check uses 4 digits up to INR 5 crore of turnover and 6 above; the turnover figure is a setting that defaults to 4. Confirm the rule and whether B2B lines need 6 digits for everyone.
4. **Table 3.1(b) and SEZ**: SEZ supplies with and without tax both go to 3.1(b). Confirm.
5. **Item numbering in the JSON** (`num` such as 1801 for 18%): unverified, see the offline-tool check.
6. **Due dates**: confirm the standard dates and the QRMP state groups, and how extensions should be entered (B-097).
7. **Table 4**: confirm that treating all purchase tax as eligible, with manual reversals, is an acceptable default for a first version.

Reviewed by: ______________________ Membership no.: ______________ Date: ______________
