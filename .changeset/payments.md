---
'@gst/payments': minor
'@gst/domain': minor
'@gst/db': minor
'@gst/print': minor
'@gst/ai': minor
'@gst/i18n': minor
'api': minor
'web': minor
---

Online payment collection (prompt 45). A business connects its own Razorpay account (secrets sealed at rest), makes a payment link or a one-time UPI QR for what an invoice owes, and the invoice marks itself paid when the signed webhook arrives: a payment allocated to the invoice, the gateway's fee posted as an expense out of the bank, and a receipt message if those are on. Replayed, simultaneous and half-finished deliveries change nothing twice. Part, over and unmatched payments go to the inbox. Payouts are fetched and checked against the payments they cover; refunds from credit notes need a second person and use up the credit note. The link is printed on the PDF and added to the share text; the phone's issued screen has a full-screen "Show QR" that turns to Paid by itself. Not run against a real Razorpay account (no credentials were available).
