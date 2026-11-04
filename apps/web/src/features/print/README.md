# Print (`features/print`)

The app side of printing: the designer, PDF actions, the preview components and bulk export. The rules and the engine are in `packages/print`; see `docs/decisions/0008-printing-pdf-templates-thermal.md`.

| File                             | What it does                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `designer.tsx`                   | Settings → Print: pick or make a template, live preview, blocks, columns, colours, wording, receipt roll, defaults, import and export |
| `page-view.tsx`                  | Draws layout pages as SVG with the same fonts the PDF embeds; the print stylesheet prints each page as a sheet                        |
| `use-print-model.ts`, `model.ts` | Business details, party, accounts and units into a print model (live from a draft, or stored for an issued document)                  |
| `use-templates.ts`               | The five presets plus the business's saved templates; the default for a document type and shell                                       |
| `fonts-client.ts`                | Loads the font files a document needs (once) and registers them with the page                                                         |
| `pdf.worker.ts`, `pdf-client.ts` | Makes PDFs and stamps CANCELLED in a Web Worker; fonts are sent once                                                                  |
| `actions.ts`                     | File names, download, keeping the PDF as an attachment, sharing and email                                                             |
| `bulk-export.tsx`                | Many documents into one ZIP, with progress and cancel                                                                                 |

Tests: `e2e/print.spec.ts` (designer, PDF download, print, share, cancel, bulk export of 20 PDFs).
