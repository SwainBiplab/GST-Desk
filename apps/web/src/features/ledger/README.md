# features/ledger

The Ledger page (prompt 50): tabs for the chart of accounts, the journal (vouchers and contras, reversal), recurring
journals, the trial balance (drill-down to a statement), the ledger statement, profit and loss, the balance sheet,
the cash flow, the day book and the year end (opening balances, close and reopen, the postings audit, the tax-head
split). Reads through `LedgerReports`, `ChartRepo`, `JournalRepo`, `RecurringJournalRepo`, `FiscalYearRepo` and
`LedgerAudit` in `@gst/db`; the arithmetic is `@gst/domain/ledger/statements.ts`. `jobs.tsx` posts due recurring
journals once a day when the app opens. Exports are CSV through the reports' download helper; print uses the page's
print styles.
