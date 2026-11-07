# Runbook: stock valuation and the Inventory ledger

Prompt 51. What to do when a business turns valuation on, changes the method, or the Inventory ledger does not equal the stock value.

## Turning valuation on

1. Settings → Inventory → Stock valuation: choose FIFO or weighted average.
2. The app posts one `reclass` voucher dated today, "Stock valued at … from …", that brings the Inventory ledger (1250) to the value of what is on hand at cost. From then on every purchase, sale, return, adjustment and opening stock posts at cost.
3. The profit and loss now shows Purchases (5000) and Changes in Inventory (5050) separately; together they are the cost of goods sold. Tell the CA.

## Changing the method

Once stock has moved under a method it is locked. Choosing the other method asks to migrate: every movement is re-costed, the movements' `cost_paise` rewritten, and the difference posted as one voucher dated today ("Valuation method changed from …"). Statements of earlier periods are unchanged; the difference lands in the period of the change. Do it at a period end.

## The books do not tie

Settings → Inventory shows the stock value, the Inventory ledger and the difference. Causes:

- a purchase or sale back-dated into a period that was already costed (the engine runs in date order, the postings were made in the order the documents were issued);
- a document issued while valuation was off, then valuation turned on (the true-up on choosing the method covers this);
- stock that went negative and was filled later at a different cost.

"Bring the ledger in line" posts the difference as a `reclass` voucher dated today. It never changes a document's own entries. The repositories' `ValuationRepo.verify` is what the screen shows; `LedgerAudit.verify` still checks that every document's entries balance (the inventory entries post with the document and reverse with it).

## Serials and batches that will not move

- "not in stock": the serial was sold, is in another godown, or was never bought in. Stock → Serials finds it and shows its history.
- "already in stock": a purchase lists a serial that is on the shelf; it must be sold or adjusted out first.
- "give the batch": a purchase of a batch item needs a batch on every line; the editor's stock details make one.
- "needs an expiry date": the item requires one; add it to the batch under Stock → Batches.
- A tracking mode cannot change while the item holds stock: adjust the stock to zero, change it, and adjust back in with batches or serials.
