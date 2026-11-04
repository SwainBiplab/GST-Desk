# Payments (`features/payments`)

Money in and out against documents, party credit, receipt vouchers, and the bank and UPI accounts. See `docs/decisions/0007-payments-allocations-and-credit.md`.

| File                           | What it does                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments-page.tsx`            | The Payments page: receive and make payments, the list with filters and CSV export, the Shop day book. Opens the form from `?intent=receive\|pay&party=` or a typed command                    |
| `payment-form.tsx`             | Party, amount, mode, account, cheque details; what is owed oldest first with automatic or manual allocation, write-off of a round-off difference, TCS on receipt, the remainder kept as credit |
| `voucher-dialog.tsx`           | A receipt voucher to print or share                                                                                                                                                            |
| `apply-credit-banner.tsx`      | Offered after issuing a document for a party with credit (an advance or a credit note)                                                                                                         |
| `accounts-tab.tsx`             | Settings → Bank and UPI: the accounts, which print on documents, and the credit or advance wording                                                                                             |
| `status-badge.tsx`, `hooks.ts` | Unpaid, partly paid, paid, overpaid and overdue badges from the derived balances                                                                                                               |

The rules are in `@gst/domain` (`payments.ts`, `ledger/posting.ts`) and the storage in `@gst/db` (`PaymentFlowRepo`, `BusinessAccountRepo`). The form never computes a balance: it asks the repository and shows what comes back.

Tests: `e2e/payments.spec.ts` (Playwright), `packages/db/src/repositories/payment-flow.test.ts` (both databases, including the reconciliation of every seeded party), `packages/domain/test/payments.test.ts`.
