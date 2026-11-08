---
'@gst/domain': minor
'@gst/db': minor
'@gst/print': minor
'@gst/i18n': minor
'web': minor
---

Counter billing (prompt 52): a Counter page in Shop mode for retail. Scan-to-add with quantity
accumulation (a USB wedge scanner is told from typing by key timing, with an optional prefix and ending
key; a camera and a serial weighing scale are supported where the device has them), quick keys for the
items sold most, an optional customer, line discounts within a cashier's limit, payment split over cash,
UPI (with a QR for what is left) and card with change, held and recalled bills, returns by scanning the
QR on a printed invoice, cash in and out, shifts opened with a float and closed with the cash counted,
the X and Z reports, a cash drawer kick and receipt through the paired printer, and a customer display on
a second window. Each counter has its own number series. Counter sales are ordinary invoices through the
document engine; the tender, drawer, shift and Z report rules and the scanner parser are pure functions in
`@gst/domain`. New tables `pos_counters`, `pos_shifts`, `pos_cash_movements`, `pos_bills`,
`pos_held_bills` (migration 0014, extras 9011). Payments can skip the receipt voucher, refunds can go back
in cash, and thermal receipts can print the invoice QR.
