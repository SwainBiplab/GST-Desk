# Pilot checklist: the counter (prompt 52)

For one real shop counter, used for a week. **Each line says what was actually done; a line that was not done says so.** Nothing here has been run on a real counter yet: every line below is **not done** until a pilot shop and its hardware are available. The automated tests (`packages/domain/test/pos.test.ts`, `packages/db/src/repositories/pos.test.ts`, `apps/web/src/features/pos/pos.test.ts`, `apps/web/e2e/pos.spec.ts`) cover the rules and the screen with a simulated scanner; they do not cover a printer, a drawer, a scale or a person at the till.

Status key: **done** (with evidence), **not done** (and who or what is needed), **n/a**.

## Before the week

| Check                                                                                    | Status       | Evidence or what is missing                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| A shop with a USB barcode scanner (keyboard wedge), a receipt printer and a cash drawer  | **not done** | Needs a pilot shop. Note the scanner's and printer's make and model here.                                       |
| Scanner prefix and ending key read off its sheet, set in Counter settings                | **not done** | Most scanners end with Enter and send no prefix: the defaults. Record what the shop's scanner needed.           |
| Items have barcodes (printed on the packs, or labels printed for the shelf)              | **not done** | Import them from CSV (Items, Import) or scan each pack into the item once. Count the items without a barcode.   |
| GST rates and HSN on the shop's top 50 items checked by the shop's CA                    | **not done** | Quick keys show the items sold most; check those first.                                                         |
| Receipt printer paired (Bluetooth) or set as the browser's printer; test receipt printed | **not done** | Bluetooth raw printing is built; USB raw printing from the desktop app is not (B-239). Say which path was used. |
| Cash drawer opens on a cash sale and from "Open drawer"                                  | **not done** | The kick goes through the printer's RJ11 port. A drawer not wired to the printer cannot be opened by the app.   |
| Weighing scale (optional) connects and reads                                             | **not done** | Web Serial needs Chrome or Edge on the counter PC. Note the scale's make and what its line looks like.          |
| Customer display on a second screen (optional)                                           | **not done** | Allow the pop-up once; drag the window to the second screen.                                                    |
| UPI ID added under Settings, Bank and UPI; a test QR scanned from a phone                | **not done** | The QR carries the amount left after cash and card.                                                             |
| Staff roles set: cashiers cannot approve, so their discount limit applies                | **not done** | Settings, Team. Set the limit in Counter settings.                                                              |

## Each day

| Check                                                                                        | Status       | Evidence or what is missing                                    |
| -------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| Shift opened with the float counted                                                          | **not done** | Record the float each morning.                                 |
| Scan-to-line feels instant on the shop's own PC (the screen shows the time of the last scan) | **not done** | Note the slowest scan seen; the target is under 100 ms.        |
| Receipt prints within a second of Complete the sale                                          | **not done** | Time ten receipts with a stopwatch; the target is under 1 s.   |
| A held bill is recalled whole                                                                | **not done** | Count how often the shop used hold.                            |
| A return is made by scanning the QR on the printed bill (or typing its number)               | **not done** | Count returns, and any the screen refused.                     |
| Shift closed with the cash counted; variance recorded; Z report printed                      | **not done** | Record each day's variance and whether it was explained.       |
| Day's takings by mode match the bank, the UPI app and the card machine's settlement          | **not done** | Compare the Z report's UPI and card lines with each statement. |

## At the end of the week

| Check                                                                                       | Status       | Evidence or what is missing                                         |
| ------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| Bills made, and none lost: number of bills equals the numbers used on each counter's series | **not done** | Compare the Z reports' bill counts with the series' last numbers.   |
| Sales and returns appear in GSTR-1 as B2CS (small unregistered) with the right tax          | **not done** | Run the GSTR-1 check for the month; the CA signs off the B2CS rows. |
| Stock counted against the books for five fast items                                         | **not done** | Use the count sheet (Items, Adjust stock).                          |
| Ledger audit shows the books tie (Ledger, Year end, Check)                                  | **not done** | Run after the week's last Z report.                                 |
| Pilot shop's feedback: what slowed them down, what they would not give up                   | **not done** | Write it here, with the top three changes to make.                  |

Signed off by: ____________________ (shop) ____________________ (Leader Group) Date: __________
