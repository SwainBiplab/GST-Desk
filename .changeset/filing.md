---
'@gst/gsp': minor
'@gst/domain': minor
'@gst/db': minor
'@gst/ai': minor
'@gst/i18n': minor
'api': minor
'web': minor
---

GST filing through the GSP (prompt 46). The taxpayer signs in to the return portal with an OTP they type (no password is kept; the session token is sealed and lives only for its six hours). From the Filing Desk's new GST portal tab, GSTR-1 is saved on the portal table by table (a nil return too, and IFF for quarterly filers), GSTR-2B is pulled into reconciliation and GSTR-2A summarised, and a return filed on the portal is picked up with its ARN; when both returns are filed the period is locked. A push is idempotent, a refusal or an expired login leaves the books as they were and raises an inbox card, and every call is metered against the plan. The desk shows a late-fee estimate. A new Filing board gives a CA every client, a cell per return and period, and the exceptions. Not run against a real GSP (no vendor sandbox was available), and GSTR-3B is exported, not saved, through it.
