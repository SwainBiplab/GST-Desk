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
