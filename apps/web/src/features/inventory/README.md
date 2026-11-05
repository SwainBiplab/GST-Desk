# features/inventory

Basic stock tracking (prompt 19, FR-110). The rules are in `packages/domain/src/inventory.ts`, the repository is `InventoryRepo` in `packages/db/src/repositories/inventory.ts`; this folder is the screens.

Stock is never stored: an item's quantity is the sum of its `stock_movements`. Documents write them when issued and reverse them when cancelled (`document-flow.ts`); this feature adds manual adjustments, counts, the negative-stock policy and the low-stock alerts. See `docs/decisions/0010-basic-inventory.md`.

## What is here

| File               | What it does                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `stock-panel.tsx`  | In an item's editor: on hand, reorder level, value at purchase price, and every movement with a link to its document.                  |
| `adjust-sheet.tsx` | The stock adjustment screen: bulk entry (add or remove, or set to counted) and the count sheet (download, fill in, bring back as CSV). |
| `settings-tab.tsx` | Settings, Inventory: allow with a warning, or do not allow, stock going below zero.                                                    |
| `hooks.ts`         | `useItemStock`, `useStockPolicy`, `useLowStock`.                                                                                       |

Elsewhere: the editor asks before issuing a document that would take stock below zero (`use-editor.ts`, `editor-page.tsx`), a delivery challan has "take the goods out of stock" and "goods will come back" (`editor-header.tsx`), the bell shows low stock (`app/components/chrome.tsx`), the stock summary report has a value column and a "below reorder level" filter (`features/reports`), and the command bar has "Adjust stock".

## Public surface

- Route: `/books/items?adjust=1` (and `/shop/items`) opens the adjustment screen; `&item=<id>` prepares a row for that item.
- Everything is hidden when the business's inventory flag is off; the movements are kept.

## Testing

```
pnpm --filter @gst/domain test        # movement direction, negative policy, count sheets
pnpm --filter @gst/db test            # inventory.test.ts: issue, cancel, challans, policy, adjustments, counts, the seeded book
pnpm --filter web build && pnpm --filter web e2e e2e/inventory.spec.ts
```
