# Backlog

| ID    | Item                                                                                                                                                              | Phase              | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| B-001 | Replace the starter HSN/SAC master (112 codes, unreviewed) with a file reviewed by a chartered accountant; extend to the full tariff (about 10,000 codes)         | P1, before release | open   |
| B-002 | Make the production HSN signing key, keep it in the secrets vault, commit its public key and rebuild the bundled version (the repository holds a development key) | P1, before release | open   |
| B-003 | Items: Shop card layout and configurable columns (Shop reuses the table; Books has fixed columns)                                                                 | P1                 | open   |
| B-004 | Items: transliteration-ready name input and Hindi, Tamil, Marathi, Bengali and Gujarati strings for the items and import screens (English only for now)           | prompt 22          | open   |
| B-005 | Bulk edit undo survives a reload (today the undo batch lives in the page; the audit log already holds the old values)                                             | P1                 | open   |
| B-006 | Effective-dated item prices and rates, so a future rate change can be scheduled per item                                                                          | prompt 54          | open   |
| B-007 | Opening stock can be corrected after creation through a stock adjustment                                                                                          | prompt 19          | done   |
| B-008 | Item pictures are stored by hash with no clean-up: delete the file when no item refers to it, and sync pictures with the database                                 | P3                 | open   |
| B-009 | Import: choose an encoding and delimiter by hand when the guess is wrong; update existing items by SKU instead of only creating                                   | P2                 | open   |
| B-010 | Reconcile the UQC list against the current GST Network list at each release                                                                                       | every release      | open   |
| B-011 | Editor: payments at the point of sale in Shop (Shop's editor has no payment field yet)                                                                            | prompt 16          | open   |
| B-012 | Editor: series and template pickers in the header (stubs today; the default series and plain preview are used)                                                    | prompts 15 and 17  | open   |
| B-013 | Editor: lines and totals in languages other than English                                                                                                          | prompt 22          | open   |
| B-014 | Engine and editor: tax rates are whole basis points, so 0.25% cannot be entered                                                                                   | P2                 | open   |
| B-015 | Editor: attachments live in the browser database only; sync them and clean up when a document is deleted                                                          | P3                 | open   |
| B-016 | Web: a Reset local data button on the Could not open the local database screen                                                                                    | P1                 | done   |
| B-017 | Editor: column visibility is saved per business in this browser, not with the business settings                                                                   | P2                 | open   |
| B-018 | Numbering: finalise provisional numbers on reconnect and block sharing a document that still has one (the repository hook `finaliseNumber` exists; sync calls it) | prompt 41          | open   |
| B-019 | Cancellation: cancel an e-invoiced document on the portal first, then here; stamp CANCELLED on the printed PDF                                                    | prompts 32 and 17  | open   |
| B-020 | Numbering: translate the series validation messages (they come from the domain package in English)                                                                | prompt 22          | open   |
| B-021 | Cancellation: show unapplied money on the party and offer to apply it to another document                                                                         | prompt 16          | open   |
| B-022 | Editing after issue: allow financial edits of reverse-charge bills and their self-invoices (today: cancel and enter again)                                        | P2                 | open   |
| B-023 | Audit: diff view for list-valued fields (lines are shown per line today), and a printable audit report for a document                                             | P2                 | open   |
| B-024 | Roles: the owner check uses `ctx.role`, which is empty on a single-user install; wire real roles when sign-in arrives                                             | prompt 40          | open   |
| B-025 | Numbering: a settings screen for synced mode and range sizes (the repository supports it; there is no screen yet)                                                 | prompt 41          | open   |
| B-026 | Payments: cheques as pending until cleared, and a bounced cheque that reopens its invoices (the balance logic already ignores payments that are not cleared)      | P2                 | open   |
| B-027 | Payments: a payment voucher document for payments made (receipts have one; payments made do not)                                                                  | P2                 | open   |
| B-028 | Payments: refund a credit note or an advance back to the party as money out                                                                                       | P2                 | open   |
| B-029 | Payments: TCS on receipt uses the default 0.1% rate; a rate and PAN-based 1% (no PAN) choice per party                                                            | P2                 | open   |
| B-030 | Payments: payment links, gateway reconciliation and reminder sending                                                                                              | prompts 44 and 45  | open   |
| B-031 | Payments: receipts as a PDF on the template designer, with the accounts chosen for documents                                                                      | prompt 17          | open   |
| B-032 | Print: save the PDF to Documents/GST Desk/<Business>/<FY>/<Type>/ on the desktop app (the browser keeps it as an attachment and downloads it)                     | prompt 23          | open   |
| B-033 | Print: send ESC/POS straight to a USB or network thermal printer from the desktop app (the bytes are generated and tested; the browser uses the print dialog)     | prompt 23          | open   |
| B-034 | Print: bold and other formatting of notes and terms on the printed page (kept in the editor and the stored text)                                                  | P2                 | open   |
| B-035 | Print: position Indic diacritics with GPOS mark anchors in the PDF (shapes are right; small offsets possible)                                                     | P2                 | open   |
| B-036 | Print: amount in words in Tamil, Bengali, Gujarati and Marathi (English or Hindi words print today)                                                               | prompt 22          | open   |
| B-037 | Print: native-speaker review of the label translations (docs/qa/print-language-review.md)                                                                         | before release     | open   |
| B-038 | Print: email with the PDF attached from the desktop app (the browser opens the mail app and saves the PDF to attach)                                              | prompt 23          | open   |
| B-039 | Print: client portal link in the share flow (a disabled placeholder today)                                                                                        | prompt 47          | open   |
| B-040 | Print: preview the designer with one of the business's real documents, not only the sample                                                                        | P2                 | open   |
| B-041 | Print: a Rust sidecar for bulk PDF on the desktop app, if the worker is too slow for thousands of documents                                                       | P3                 | open   |
| B-042 | Reports: a summary table per business and month for one report, if the browser database proves too slow on a very large book (not needed at 50,000 documents)     | P3                 | open   |
| B-043 | Reports: print through a report template in the designer (a plain report sheet prints today)                                                                      | P2                 | open   |
| B-044 | Reports: stock summary by godown and batch, and valued by cost (FIFO or weighted average) instead of the current purchase price                                   | prompts 51 and 52  | open   |
| B-045 | Reports: expense summary by a real expense category (expenses are grouped by their line description today)                                                        | P2                 | open   |
| B-046 | Reports: GSTR-1 preview by table (B2B, B2CL, B2CS, CDNR, EXP) and HSN split into B2B and B2C                                                                      | prompt 33          | open   |
| B-047 | Reports: GST summary separates ineligible credit, reverse-charge inward supplies and ITC reversals (all purchase tax counts as credit today)                      | P2                 | open   |
| B-048 | Reports and dashboards: Hindi, Tamil, Marathi, Bengali and Gujarati strings (English only for now)                                                                | prompt 22          | open   |
| B-049 | Dashboard: filing due dates follow government extensions and the business's QRMP choice (the usual 11th and 20th are shown today)                                 | prompt 33          | open   |
| B-050 | Reports: stream a very large export to a file on the desktop app instead of building it in memory                                                                 | prompt 23          | open   |
| B-051 | Dashboard: a trend chart of the last six months of sales and spend (the cards show this month against last month)                                                 | P2                 | open   |
| B-052 | Reports: opening and closing balance on the cash book and the bank book (movements only today)                                                                    | P2                 | open   |
| B-053 | Inventory: cost-based valuation (FIFO, weighted average) instead of valuing stock at the current purchase price                                                   | prompt 51          | open   |
| B-054 | Inventory: a returnable delivery challan can be marked returned, restoring the stock it took out                                                                  | P2                 | open   |
| B-055 | Inventory: transfers between godowns and per-godown stock (one default godown today)                                                                              | prompt 51          | open   |
| B-056 | Inventory: reorder suggestions and a purchase order from the low-stock list                                                                                       | P2                 | open   |
| B-057 | Inventory: cancelling a purchase whose goods were already sold leaves stock negative without asking; offer to cancel the sale first or book an adjustment         | P2                 | open   |
| B-058 | Inventory: Hindi, Tamil, Marathi, Bengali and Gujarati strings for the stock screens (English only for now)                                                       | prompt 22          | open   |
