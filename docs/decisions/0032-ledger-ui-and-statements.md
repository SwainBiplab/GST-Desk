# 0032 — The ledger in the open: chart, journals, statements, year end

Status: accepted. Context: prompt 50, PRD FR-074, the Phase 0 decision to post on issue (ADR 0002's ledger tables, the posting rules of `@gst/domain/ledger/posting.ts`).

## Decision

- **The books were already there; this prompt shows them.** Every issued document and every payment has posted
  balanced entries since Phase 1. The statements are pure arithmetic over per-account debit and credit sums
  (`@gst/domain/ledger/statements.ts`): the trial balance (opening, movement, closing; it throws if the two closing
  columns differ), the ledger statement's running balance on the account's natural side, profit and loss (income
  less expenses, grouped by sub-group, with an optional comparative span), the balance sheet (assets against
  liabilities, equity and the profit of the years not yet closed, carrying the difference it found, zero when the
  books tie), a simple indirect cash flow (profit, then each non-cash balance that moved, tied to the cash and bank
  accounts' change), and the closing entries. A property test posts random sequences of documents and payments
  through the rules and asserts all of it ties, every run.
- **One ledger per tax head, and per bank account.** New businesses get Output and Input CGST, SGST, UTGST, IGST and
  Cess as their own ledgers (2110 to 2150, 1310 to 1350), capital, drawings, retained earnings, TDS receivable and
  the discount accounts; older businesses keep what they posted to the combined 2100 and 1300 until the year-end
  screen's "Split tax by head" moves each year's balances with one `reclass` voucher derived from the documents
  themselves. A receipt or payment on a business account posts to that account's own ledger (made on first use,
  carrying the business account's id), so the bank ledgers equal the bank accounts.
- **A voucher is never edited.** A journal (or contra, opening, closing, recurring, reclass) voucher is at least two
  lines, each a debit or a credit, balanced before the transaction starts, numbered per kind and year
  (`JV/25-26/0001`), refused inside a locked period unless an owner gives a reason and inside a closed year
  altogether; it is corrected by an equal and opposite `reversal` voucher, and both stay. Opening balances are one
  `opening` voucher per year, balanced through Opening Balance Equity and replaced by reversal when entered again.
  Recurring journals post one voucher per schedule date, never twice for the same date, when the app opens or on
  request.
- **Closing a year is a voucher and a lock.** Income and expense accounts are brought to zero into Retained Earnings
  by one `closing` voucher dated the last day (left out of the profit and loss and the cash flow, which read the
  year as it was), the books are locked to that day, and earlier years must be closed first. Reopening is an
  owner's act with a reason: the closing voucher is reversed, the lock moves back to the previous closed year, and
  the audit trail carries both.
- **Verify and repair, not rebuild.** The audit lists every issued posting document and every cleared payment
  without entries, every document or voucher whose entries do not balance, the combined tax ledgers still in use,
  and the receivables and payables control accounts against the sum of the parties' positions (as of now, as the
  positions are). Repair posts the rules' entries for what is missing, marked `(repaired)`, and nothing else.

## Consequences

- Purchases are expensed as bought: the profit and loss is a trading view without a stock adjustment until
  valuation arrives (prompt 51; B-221).
- The chart's sub-groups drive the statements; a user account without a group lands in the type's default group.
- The demo seed still posts payments to the combined Bank ledger; businesses made after this prompt post per
  account.

## Verified

`packages/domain/test/ledger-statements.test.ts` (statements and the property test), `packages/db/src/repositories/ledger.test.ts`
on SQLite and Postgres (the trial balance equals the sales register net of credit notes; the balance sheet ties and
its control accounts equal the parties' positions; vouchers, reversal, opening balances, recurring, the lock, the
close and reopen, verify and repair), `apps/web/e2e/ledger.spec.ts` (a voucher that must balance, the trial balance
drill-down, the P&L export, the audit). A chartered accountant's tie-out of the seed's statements to the registers
is the sign-off sheet `docs/compliance/ledger-review.md` (not yet signed).
