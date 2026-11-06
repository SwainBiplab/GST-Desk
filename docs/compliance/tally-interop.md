# Tally interoperability: reviewer sign-off

**Status: NOT SIGNED.** The Tally XML this software writes and reads was produced from public documentation of Tally's XML import and export. It has **not** been imported into TallyPrime, and the reader has **not** been run on a real Tally export. The Vyapar fixtures in `fixtures/vyapar/` are synthetic. What is proven is that the writer, the reader and the importer agree with each other and that the resulting books balance. Do not move a real business over, or hand an export to a client's accountant, until the checks below are done.

## What the code guarantees (tested)

| #   | Property                                                                                                  | Test                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Every voucher the writer produces balances to the paisa, or a warning names it                            | `tally export` cases in `packages/interop/test/interop.test.ts`                   |
| 2   | A party is debited on a sale and credited on a purchase; notes mirror them; round-off sits inside voucher | same                                                                              |
| 3   | The reader returns the documents, parties, items and payments the writer was given                        | "reads the masters and vouchers this software writes..."                          |
| 4   | Export, then import into a fresh business, gives the same totals, tax heads, round-off and receivables    | `packages/db/src/repositories/interop.test.ts` "round trip" (SQLite and Postgres) |
| 5   | A 50,000 voucher file is read in pieces without a tree of the whole                                       | "streams a large file without holding it"                                         |
| 6   | UTF-16 files, `&#4;` references and tags split across pieces are read                                     | xml cases                                                                         |
| 7   | An imported document is always priced by the tax engine; a total that differs by more than INR 1 is shown | "reports a document whose total the engine does not reproduce..."                 |
| 8   | Original numbers are kept in an Imported series that is never the default; a clash is renumbered `/IMP`   | "the Imported series is not the default...", "imports the same file twice..."     |
| 9   | A locked period, a composition business and a blank document stop an import row, with the reason          | locked-period and composition cases                                               |

## Open points for the reviewer

1. **Voucher type for a sales-side debit note.** This software has a debit note that adds to sales (it is issued to a customer). Tally's "Debit Note" is normally a purchase return. The writer uses "Debit Note" for both and the reader tells them apart by the ledger group of the line (Sales Accounts or Purchase Accounts). Confirm that is how the firm's Tally company records an extra charge to a customer, or give the voucher type it uses.
2. **Round-off.** Written as a ledger line named "Round Off" inside each voucher, not as a separate journal. Confirm.
3. **Per-line tax rate on import.** A Tally voucher gives tax ledgers, not rates per line. Lines take the stock item's rate when the master has one, otherwise the voucher's effective rate. Confirm that is acceptable for a business with several rates on one voucher, or whether such vouchers should be refused.
4. **TCS and TDS ledgers on a voucher** are reported and not imported; the file's total will then differ from the engine's and the review says so.
5. **Receipts and payments** are imported as party credit and not allocated to invoices. Confirm, or specify how references should be matched.
6. **Stock opening balances, godowns, batches, bill-wise outstanding and cost centres** are not read.
7. **Numbers over 16 characters or with characters the GST portal refuses** are imported as they were and flagged; the GSTR-1 export will flag them again.

## Checks that need the real thing

| Check                                                                                                    | Done | Notes |
| -------------------------------------------------------------------------------------------------------- | ---- | ----- |
| The masters file and the vouchers file import into TallyPrime without error                              |      |       |
| Ledger balances in Tally after import equal the trial balance here for the same period                   |      |       |
| A real Tally export (masters and a year of vouchers, UTF-16) reads, and its documents match the register |      |       |
| A real Vyapar export of each report reads with the column mapping, or the aliases are corrected          |      |       |
| The row counts and totals of the review agree with the source system's own reports                       |      |       |

Reviewed by: ______________________ Membership no.: ______________ Date: ______________
