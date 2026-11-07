# Runbook: GST filing through the GSP

1. Set `SECRETS_KEY`, and either `GSP_BASE_URL` (+ `GSP_SANDBOX`) for a vendor or, outside production, `GSP_PRACTICE=true`.
   Without either, the Filing Desk says no GSP is set up.
2. A person with GST edit rights opens Filing Desk, enters the portal user name, sends the OTP and types it. The login
   lasts about six hours; a job that finds it expired stops and says so, and a card appears in the inbox.
3. Save GSTR-1 from a period's GST portal tab. Problems standing block it (fix or acknowledge them on the Checks tab). A
   refused invoice shows its code and reference; fix it and save again. Saving does not file: file on the portal, then
   press Check if filed (the scheduler also asks every 30 minutes while someone is signed in).
4. Pull GSTR-2B when the portal has made it (it says plainly when not); the job reports what reconciliation found, and the
   GSTR-2B tab has the detail. GSTR-2A is summarised only.
5. The Filing board (CA) lists every client the account belongs to: overdue returns, problems waiting, and credit not
   reconciled.
6. Calls count against the plan's `gspCalls`; one past the limit is refused with a plain message.
7. Never put an OTP, token or invoice number in a ticket; use job ids and periods.
