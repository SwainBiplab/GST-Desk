# features/inventory

Stock tracking (prompt 19, FR-110; prompt 51, FR-111 and FR-112). The rules are in `packages/domain/src/inventory.ts` and `packages/domain/src/stock/` (valuation, picking); the repositories are `InventoryRepo`, `GodownRepo`, `TransferRepo`, `BatchRepo`, `SerialRepo` and `ValuationRepo` in `packages/db/src/repositories/`; this folder is the screens. See `docs/decisions/0010-basic-inventory.md` and `docs/decisions/0033-advanced-inventory.md`.

Stock is never stored: an item's quantity is the sum of its `stock_movements`. Documents write them when issued and reverse them when cancelled (`document-flow.ts`); this feature adds manual adjustments, counts, the negative-stock policy and the low-stock alerts. See `docs/decisions/0010-basic-inventory.md`.

## What is here

| File                | What it does                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock-panel.tsx`   | In an item's editor: on hand (per godown, per batch, serials in stock), reorder level, value under the method, and every movement with a link to its document.    |
| `adjust-sheet.tsx`  | The stock adjustment screen: bulk entry (add or remove, or set to counted) per godown, with the batch or serials, and the count sheet per godown.                 |
| `settings-tab.tsx`  | Settings, Inventory: the negative-stock policy and the valuation method (FIFO or weighted average), with the Inventory ledger check and true-up (prompt 51).      |
| `stock-details.tsx` | The editor's stock details dialog (Enter on the stock column): godown, batch (first expiry first unless chosen) and serials, checked against the stock.           |
| `stock-page.tsx`    | The Stock page (G then T): stock by godown, godowns and per-godown reorder levels, batches and expiry, transfers, and where a serial number is.                   |
| `hooks.ts`          | `useItemStock`, `useItemDetail`, `useStockPolicy`, `useLowStock`, `useGodowns`, `useGodownStock`, `useBatches`, `useTransfers`, `useValuation`, `useStockLabels`. |

Elsewhere: the editor asks before issuing a document that would take stock below zero (`use-editor.ts`, `editor-page.tsx`), a delivery challan has "take the goods out of stock" and "goods will come back" (`editor-header.tsx`), the bell shows low stock (`app/components/chrome.tsx`), the stock summary report has a value column and a "below reorder level" filter (`features/reports`), and the command bar has "Adjust stock".

## Public surface

- Route: `/books/items?adjust=1` (and `/shop/items`) opens the adjustment screen; `&item=<id>` prepares a row for that item.
- Everything is hidden when the business's inventory flag is off; the movements are kept.

## Testing

```
pnpm --filter @gst/domain test        # movement direction, negative policy, count sheets; stock-valuation.test.ts: FIFO, weighted average, FEFO, serials
pnpm --filter @gst/db test            # inventory.test.ts and stock-advanced.test.ts (the pharma seed, valuation that ties, transfers, serials at scale)
pnpm --filter web build && pnpm --filter web e2e e2e/inventory.spec.ts e2e/inventory-advanced.spec.ts
```
