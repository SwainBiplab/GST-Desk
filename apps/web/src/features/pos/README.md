# features/pos

The counter (prompt 52, FR-113 and FR-114): barcode-first billing for a shop, in Shop mode (`/shop/pos`). Counter sales are
ordinary invoices made through `DocumentFlowRepo`; `PosRepo` (`packages/db/src/repositories/pos.ts`) adds counters, shifts,
split payments, held bills, returns and the Z report, and the rules are pure functions in `packages/domain/src/pos.ts`.
See `docs/decisions/0034-counter-billing.md`.

## What is here

| File                   | What it does                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pos-page.tsx`         | The counter screen: scan box, cart, total, function keys, shift gating; `?display=1` is the customer's screen.  |
| `dialogs.tsx`          | Pay (split tenders, change, UPI QR), return, open shift, cash in and out, close and Z report, recall, settings. |
| `model.ts`             | Pure: the item index, scan resolution, the cart, discount limit, pricing through the document engine.           |
| `use-pos.ts`           | Hooks: settings, counters, shift, held bills, the item index, quick keys, the receipt of an issued bill.        |
| `hardware.ts`          | Receipts to Bluetooth or the browser, the drawer kick, the customer display channel, the serial scale.          |
| `customer-display.tsx` | The second window: lines, total, and change after payment.                                                      |

## Public surface

- Route: `/shop/pos` (also `/books/pos`); `/shop/pos?display=1` is the customer display and needs no business.
- Keys: F2 pay, F3 hold, F4 recall, F6 return, F8 cash in or out; an empty Enter pays; `3*code` sells three. See `docs/keyboard.md`.

## Testing

```
pnpm --filter @gst/domain test        # pos.test.ts: wedge parsing, tenders, drawer, Z report
pnpm --filter @gst/db test            # pos.test.ts: counters, shifts, sales, returns, close, 500 bills
pnpm --filter web test                # features/pos: index, cart, speed
pnpm --filter web build && pnpm --filter web e2e e2e/pos.spec.ts
```

Pilot checklist for a real counter: `docs/qa/pos-pilot.md` (not done: needs a shop).
