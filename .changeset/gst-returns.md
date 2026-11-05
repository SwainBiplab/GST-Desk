---
'@gst/domain': minor
'@gst/db': minor
'@gst/ai': minor
'@gst/i18n': minor
'web': minor
---

GST returns (prompt 30). A Filing Desk at `/books/gst` prepares GSTR-1 and GSTR-3B from issued documents per month or quarter (QRMP): B2B, B2CL, B2CS, credit and debit notes, exports, nil-rated and exempt supplies, the HSN summary split into B2B and B2C, and the documents-issued table; and for GSTR-3B the outward, inward reverse-charge, ITC and payment-estimate tables. Each period shows its status (not started, ready, exported, filed, late), the due date, and the problems to fix; you can export JSON (and CSV files in a ZIP), record the ARN and filing date, reopen with a reason, and change an ITC figure with a reason kept in the audit trail. GSTR-1 equals the GST summary report to the paisa on the seeded book. Problems also appear as inbox cards. Hindi is complete. **The file layout is reconstructed from public documentation and has not been checked in the GST offline tool, and no chartered accountant has reviewed the rules: do not file with these exports yet** (`docs/compliance/gstr-review.md`, ADR 0016).
