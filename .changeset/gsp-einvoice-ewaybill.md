---
'@gst/gsp': minor
'@gst/db': minor
'@gst/domain': minor
'@gst/ai': minor
'@gst/i18n': minor
'web': minor
---

e-Invoices and e-way bills. An issued invoice can now be checked against what the GST portal would refuse (each problem with where it is), sent for an IRN, and printed with the IRN and its QR; an IRN can be cancelled within 24 hours (the document is cancelled with it) and after that the screen points to a credit note. E-way bills can be made, have their vehicle changed, be extended in the last 8 hours of their validity and be cancelled, and a list shows how many hours each has left. Requests wait in a queue when there is no connection or the portal logins are locked, are never sent twice, and a document that changes after it was queued stops its request and puts a card in the review inbox. After an IRN the document cannot be changed or cancelled directly. The portal logins are sealed on the device with a PIN. Until a GSP is set up the app runs in practice mode, which sends nothing and says so on every screen. The portal's error codes are explained in plain words. Not yet tried against a real GSP sandbox (see docs/compliance/einvoice-sandbox-run.md).
