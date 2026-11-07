# Ledger and financial statements: reviewer sign-off

Scope: the **trial balance**, **profit and loss**, **balance sheet**, **cash flow** and **ledger statements** of the
seeded demo business (prompt 50), tied to the registers and the party positions. Code:
`packages/domain/src/ledger/statements.ts`, `packages/db/src/repositories/ledger.ts`, `apps/web/src/features/ledger`.
The automated tests prove the statements tie to each other and to the registers; this sheet is for a chartered
accountant to confirm they are what a firm and its CA need.

## How to review

1. Settings → load the demo business (Books). Open Ledger.
2. Trial balance for FY 2024-25 (1 April 2024 to 31 March 2025): confirm the closing columns are equal, then open
   Sales (4000) and tie its credit less debit to Reports → Sales register, Custom dates, the same year (taxable total).
3. Profit and loss for the same year: tie Income to the sales register and Purchases (5000) to the purchase register.
4. Balance sheet as at 31 March 2025: confirm "The books tie". Tie Receivables to Reports → Party outstanding
   (receivable side) and Payables to the payable side, as at the same date.
5. Year end → Check: confirm every document and payment has postings and the control accounts tie.
6. Post a journal voucher (rent against bank), reverse it, and confirm both appear in the statement and the day book.
7. Close FY 2024-25 and confirm the balance sheet still ties with the profit now in Retained Earnings; reopen it with
   a reason and confirm the audit trail shows both.

## What the software does

| #   | Rule                                                                                                                                                       | Test                                                                                               | Reviewed |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| 1   | Every issued invoice, bill of supply, note, purchase bill and expense posts balanced entries; quotations, proformas, challans and receipt vouchers do not. | `packages/domain/test/engine.test.ts` (posting vectors), `ledger-statements.test.ts` property test |          |
| 2   | The trial balance's two closing columns are always equal; a difference is an error, not a figure.                                                          | `statements.test` "ties"; `ledger.test` "the trial balance ties"                                   |          |
| 3   | The Sales ledger's net credit for a span equals the sales register's taxable total net of credit notes.                                                    | `ledger.test` "sales equal the sales register net of credit notes"                                 |          |
| 4   | Assets equal liabilities, equity and the profit of the open years; the receivables and payables control accounts equal the parties' positions.             | `ledger.test` "the balance sheet ties"; the audit's control check                                  |          |
| 5   | A journal voucher must balance, cannot be edited, is reversed by an opposite voucher, and is refused in a locked period without an owner's reason.         | `ledger.test` "a journal voucher must balance…", "a locked period refuses…"                        |          |
| 6   | Closing a year zeroes income and expenses into Retained Earnings and locks the books; reopening needs an owner and a reason and is audited.                | `ledger.test` "closing a year…"                                                                    |          |
| 7   | The profit and loss of a closed year reads as it did before the close (the closing voucher is left out).                                                   | same                                                                                               |          |
| 8   | Output and input GST post per head; older combined balances are moved by a reclassification voucher built from the documents.                              | `document-flow.test` (per-head codes); `LedgerAudit.reclassifyTaxHeads`                            |          |
| 9   | Exports hold every row with amounts in rupees as numbers and a totals row.                                                                                 | `ledger.spec.ts` "the P&L exports"                                                                 |          |

## Review results

| Statement (FY 2024-25)        | Software figure | Tied to                               | Differences found |
| ----------------------------- | --------------- | ------------------------------------- | ----------------- |
| Trial balance closing Dr = Cr |                 | —                                     |                   |
| Sales (4000) net credit       |                 | Sales register taxable (net of CN)    |                   |
| Purchases (5000) net debit    |                 | Purchase register taxable (net of PR) |                   |
| Receivables (1200)            |                 | Party outstanding, receivable         |                   |
| Payables (2000)               |                 | Party outstanding, payable            |                   |
| Net profit                    |                 | P&L                                   |                   |
| Cash and bank closing         |                 | Receipts and payments report          |                   |

## Open points for the reviewer

1. **Stock in the books.** With a valuation method chosen (Settings → Inventory, prompt 51) every movement posts at
   cost: goods in debit Inventory (1250) and credit Changes in Inventory (5050), goods out the reverse, so the profit
   and loss shows Purchases (5000) and Changes in Inventory separately and their sum is the cost of goods sold
   (Schedule III). Without a method the profit and loss stays a trading view. Confirm the presentation and the
   account names; the demo business has no method chosen.
2. **Cash flow classification.** Every balance sheet movement outside cash and bank is "operating" unless its
   account's group is capital, drawings, reserves or loans (financing) or fixed assets and investments (investing).
   Confirm the groups and names.
3. **Round-off and discounts.** Round-off posts to one expense account on either side; discounts have their own
   accounts but the document engine does not post to them yet (line discounts reduce the taxable value).
4. **Opening balance equity.** Party opening balances and account opening balances both balance through Opening
   Balance Equity (3100); confirm that this is acceptable or should be capital.
5. **Tax heads.** Confirm the per-head ledger names and codes, and the reclassification voucher as the way to move an
   older business's combined balances.

Reviewer: ____________________ Date: __________ Signature: ____________________
