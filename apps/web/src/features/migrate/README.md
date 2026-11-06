# Moving data in and out (prompt 34)

Route `/books/migrate` (page id `migrate`), also reached from the setup wizard when "Import" is chosen.

- `import-flow.tsx`: source, file, column mapping, a dry run, the import, and a log of earlier imports (kept in settings under `migrations`).
- `mapping-editor.tsx`: which column feeds which field, for parties, items and documents.
- `read-file.ts`: a Tally file is decoded as it streams in; Excel and CSV files become sheets with a heading row.
- `model.ts`: sheets to one bundle, including a header sheet joined to a lines sheet.
- `export-tab.tsx`: masters and vouchers for a financial year as Tally XML, with editable ledger names (kept in settings under `tally.names`).
- `hooks.ts`: the repository calls.

The readers, writers and spreadsheet parsing are in `@gst/interop`; matching, the dry run and writing are `InteropRepo` in `@gst/db`. See `docs/decisions/0020-data-migration-tally-vyapar-excel.md` and `docs/compliance/tally-interop.md`.
