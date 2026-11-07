---
'@gst/domain': minor
'@gst/db': minor
'@gst/i18n': minor
'web': minor
---

The ledger in the open (prompt 50). A Ledger page with the chart of accounts (system ledgers per tax head and per
bank account, user accounts with groups and Tally names), journal and contra vouchers that must balance and are
corrected by reversal, recurring journals, the trial balance with drill-down to a ledger statement, profit and loss
and the balance sheet with comparatives, a simple cash flow, the day book, opening balances, the year-end close and
its owner-only reopen, and an audit that finds and repairs missing postings and ties the control accounts to the
parties. The statements are pure functions in `@gst/domain` with a property test that any accepted sequence of
documents and payments keeps the books in balance; the repositories are tested on SQLite and Postgres against the
seeded business. New tables: `journal_vouchers`, `recurring_journals`, `fiscal_years`; new columns on
`ledger_accounts` and `ledger_entries` (migration 0012, extras 9009).
