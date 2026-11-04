# features/items and features/import

Item catalogue, units, HSN suggestions, bulk edit, the rate change assistant and the CSV import wizard (items and parties). Design: `docs/decisions/0004-items-and-hsn-master.md`.

## Public pieces

| File                                  | Purpose                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `items-page.tsx`                      | The page. `?new=1` create, `?edit=<id>` edit, `?import=1` import wizard. Drawer in Books, full page in Shop. |
| `item-list.tsx`                       | Virtualised table: search (FTS), filters, sort, selection, export, bulk edit, undo.                          |
| `item-form.tsx`, `item-editor.tsx`    | Form and its save logic. Repository rejections (duplicate SKU, foreign unit) show against the right field.   |
| `form.ts`                             | Draft, validation through `validateItemInput`, conversion to stored values. Shared with the import.          |
| `hsn-field.tsx`                       | HSN/SAC input with a suggestion popover (top 3, rate, reason) from the offline rules provider.               |
| `bulk-edit.tsx`, `rate-assistant.tsx` | Preview then apply; both produce a batch that can be undone.                                                 |
| `units-dialog.tsx`                    | Standard UQC units and custom units mapped to a UQC.                                                         |
| `hsn-master-dialog.tsx`               | Installed versions and the optional update address.                                                          |
| `import-items.ts`                     | File row to item draft; review of a whole file against stored SKUs and barcodes.                             |
| `../import/import-wizard.tsx`         | Upload, mapping, dry-run review, import with progress and cancel. Takes an `ImportSpec`.                     |
| `../parties/import-parties.ts`        | The same for parties (state by name or code, signed opening balance).                                        |
| `../../lib/hsn.ts`                    | Load the bundled master; check for and import a signed update.                                               |

## Testing

- `pnpm --filter web test` runs the unit tests (`items.test.ts`, `import.test.ts`, which opens a real in-memory database).
- `pnpm --filter web e2e -- items.spec.ts` runs the browser flows against the production build (stop any dev server on port 1420 first).
- `pnpm --filter web perf` includes `perf/items.perf.ts`: a 10,000-row import and grid and command bar timings.

## Adding a field to the import

Add it to `ITEM_FIELDS` or `PARTY_FIELDS` in `@gst/domain` (`import-map.ts`) with its header aliases, read it in `import-items.ts` or `import-parties.ts`, add its label under `import.fields` in `lib/i18n.ts`, and add the column to the export in `csv.ts` so a file can make the round trip.
