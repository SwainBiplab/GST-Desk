# @gst/interop

Moving data in and out: a Tally XML writer and reader, and reading documents from Vyapar and Excel files. Pure TypeScript, no I/O and no storage; it depends only on `@gst/domain`. The database side (matching, dry run, writing) is `ImportRepo` in `@gst/db`.

- `xml.ts`: a small XML writer, and a streaming reader that hands back one master or voucher at a time so a 50 MB file is never held whole.
- `types.ts`: the neutral shapes every source is turned into (`ImportBundle`, `ImportParty`, `ImportItem`, `ImportDocument`, `ImportPayment`).
- `tally-export.ts`: masters and vouchers from plain records into a TallyPrime import envelope.
- `tally-import.ts`: masters and vouchers from a Tally export into the neutral shapes.
- `documents.ts`: documents with lines from spreadsheet rows (one row per line, or a header sheet and a lines sheet), with the spellings Vyapar uses.

None of the Tally layouts has been run against TallyPrime or a real Tally export; see `docs/compliance/tally-interop.md`.
