---
'@gst/domain': minor
'@gst/db': minor
'@gst/ai': minor
'@gst/i18n': minor
'web': minor
---

Advanced inventory (prompt 51): items tracked by batch (with expiry) or serial number, godowns with
stock per godown, per-godown reorder levels and two-step transfers, and stock valuation at FIFO or
weighted average with cost of goods sold posted to the ledger on every sale. The editor's lines carry
a godown, a batch (first expiry first unless chosen) and serials (pasted or scanned, checked against
the stock); purchases make batches and serials. A Stock page (G then T) shows stock by godown,
godowns, batches and their expiry, transfers and where a serial is; Settings, Inventory chooses the
method, shows whether the Inventory ledger equals the stock value and trues it up. Reports: stock
value by item, batch or godown, expiry, dead stock, stock ageing and a movement register; the stock
summary takes a godown and is valued by the method. Inbox: `expiry_due`. The valuation engine and
the picking rules are pure functions in `@gst/domain`; new tables `serials`, `stock_transfers`,
`stock_transfer_lines`, `godown_levels` and new columns on items, batches, godowns, document lines
and movements (migration 0013, extras 9010).
