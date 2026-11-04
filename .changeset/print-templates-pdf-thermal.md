---
'@gst/print': minor
'@gst/domain': minor
'@gst/db': minor
'@gst/i18n': minor
'web': minor
---

PDF templates, the template designer, thermal receipts and sharing. A new `@gst/print` package lays a document out once and draws it as the live preview and as a PDF with embedded font subsets and selectable text, in six languages and five presets (Classic, Modern, Compact, Tally-like, Retail), with Rule 48 copies, DRAFT and CANCELLED watermarks, and pagination that never splits a line and moves the totals whole. Settings gets a designer (blocks, columns, colours, wording, receipt roll, defaults per document type and shell, import and export). PDFs are made in a Web Worker, kept with the document, stamped CANCELLED on cancellation, shared through the share sheet or WhatsApp, and exported in bulk as a ZIP. Thermal receipts are generated as ESC/POS bytes for 58 and 80 mm rolls, with a browser-print fallback.
