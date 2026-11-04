# Backlog

| ID    | Item                                                                                                                                                              | Phase              | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| B-001 | Replace the starter HSN/SAC master (112 codes, unreviewed) with a file reviewed by a chartered accountant; extend to the full tariff (about 10,000 codes)         | P1, before release | open   |
| B-002 | Make the production HSN signing key, keep it in the secrets vault, commit its public key and rebuild the bundled version (the repository holds a development key) | P1, before release | open   |
| B-003 | Items: Shop card layout and configurable columns (Shop reuses the table; Books has fixed columns)                                                                 | P1                 | open   |
| B-004 | Items: transliteration-ready name input and Hindi, Tamil, Marathi, Bengali and Gujarati strings for the items and import screens (English only for now)           | prompt 22          | open   |
| B-005 | Bulk edit undo survives a reload (today the undo batch lives in the page; the audit log already holds the old values)                                             | P1                 | open   |
| B-006 | Effective-dated item prices and rates, so a future rate change can be scheduled per item                                                                          | prompt 54          | open   |
| B-007 | Opening stock can be corrected after creation through a stock adjustment                                                                                          | prompt 19          | open   |
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
