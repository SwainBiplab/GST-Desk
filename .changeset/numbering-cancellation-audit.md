---
'@gst/domain': minor
'@gst/db': minor
'web': minor
---

Numbering series, cancellation, period lock and audit trail. Several number series per document type, each restarting by financial year, with defaults per type and per shell, GST limits checked when the series is saved, and a live preview. Issuing is serialised so numbers never repeat or skip; groundwork for per-device number ranges and provisional numbers. Issued documents can be cancelled with a reason (number kept, ledger and stock reversed, payments unapplied) and edited afterwards: notes always, amounts as a numbered revision. A period lock needs an owner and a reason to work inside it. Settings gets Numbering and Audit tabs, and each issued document a History tab.
