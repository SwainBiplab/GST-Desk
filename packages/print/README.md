# @gst/print

Printing for GST Desk: templates, one layout engine, PDFs, thermal receipts. See `docs/decisions/0008-printing-pdf-templates-thermal.md`.

| File                                        | What it does                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `spec.ts`, `presets.ts`                     | `TemplateSpec` (zod-validated JSON), the five presets, import and export, block and column editing                               |
| `model.ts`, `stored.ts`                     | The print model: from the editor's draft and engine result, or from the stored rows of an issued document (nothing recalculated) |
| `layout.ts`                                 | The layout engine: model and spec in, positioned boxes out; pagination, copies, watermarks                                       |
| `fonts.ts`, `fonts.node.ts`, `fonts.web.ts` | Script runs, measuring with real font files (shaped for Indic scripts), loading in Node and the browser                          |
| `pdf.ts`                                    | Draws the boxes with pdf-lib (subset fonts, real text, vector QR, deterministic); stamps CANCELLED on an existing PDF            |
| `escpos.ts`                                 | Receipt lines for a 58 or 80 mm roll, as ESC/POS bytes or as text for the browser's print dialog                                 |
| `sample.ts`                                 | A sample document built by the real engine (the designer's preview, and the tests)                                               |

The preview, the PDF and the tests all consume the same `layoutDocument` result, so they cannot disagree. Labels come from `@gst/i18n` (`PRINT_CATALOGUE`, six languages).

Tests: `pnpm --filter @gst/print test` (layout and pagination at 1, 25, 60 and 200 lines, every preset on every page size, a layout-box snapshot, PDF validity and text extraction, ESC/POS bytes, speed). `packages/db/src/print-rule46.test.ts` prints real documents and checks every Rule 46 field.
