---
'@gst/domain': minor
'@gst/db': minor
'web': minor
---

Basic inventory. Stock is the sum of an item's movements: documents write them when issued and reverse them when cancelled (sales, bills of supply, debit notes and purchase returns out; purchase bills and credit notes in; delivery challans out only when set to, with a returnable flag). Each item shows its stock, reorder level, value at purchase price and every movement with a link to its document. A stock adjustment screen books quantities for many items at once (add or remove, or set to counted) with a reason, and brings in a count sheet as CSV with a line-by-line list of anything it could not use. A business can allow stock to go below zero with a warning, or refuse the document at issue. Items below their reorder level feed the dashboard, the notification bell and a filter on the stock summary, which now carries value. Inventory can be switched off per business without losing movements. A test rebuilds every seeded item's stock from the documents and compares it with the movements.
