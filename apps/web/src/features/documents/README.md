# Document editor (`features/documents`)

The spreadsheet-style editor for every document type: invoices, bills of supply, quotations, delivery challans, credit and debit notes, purchase bills and the rest. See `docs/decisions/0005-document-editor.md` for why it is built this way.

| File                                              | What it does                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `editor-page.tsx`, `editor-route.tsx`, `adopt.ts` | Composes the screen; keeps it mounted when a new draft gets its id              |
| `use-editor.ts`                                   | Draft state, pricing (once per change), 2 s autosave, issue                     |
| `state.ts`                                        | Pure draft edits: cells, paste, reorder, remove, applying an item or a party    |
| `line-grid.tsx`                                   | Glide grid. Item column is pick-only; handlers go through a ref                 |
| `party-picker.tsx`, `item-picker.tsx`             | Search by keyboard, quick-create, quantity entry in the item picker             |
| `editor-header.tsx`, `editor-footer.tsx`          | Dates, place of supply, reverse charge, export; discount, TCS/TDS, notes, files |
| `purchase-extras.tsx`, `files.ts`                 | Supplier invoice details, attachment viewer, magic-byte file checks             |
| `preview.tsx`, `trace-view.tsx`                   | Debounced A4/thermal preview; the engine trace in plain language                |
| `convert-dialog.tsx`, `documents-page.tsx`        | Convert and duplicate; drafts and issued list                                   |

Keyboard: Enter on an item cell opens the picker; Tab goes to quantity; Enter adds the line and moves to the next. Ctrl+S saves the draft, Ctrl+Enter issues.

Tests: `documents.test.ts` (unit), `e2e/documents.spec.ts` (Playwright), `perf/documents.perf.ts` (200 lines; budgets in `perf/budgets.json`).
