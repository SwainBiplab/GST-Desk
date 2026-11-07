# 0029 — GST filing through the GSP: portal login, push, pull, filing status, the CA board

Status: accepted. Context: prompt 46, PRD FR-083, FR-084, UX-03, cloud tier.

## Decision

- **The OTP is the taxpayer's.** The return portal logs in with an OTP sent to the registered number. The person types it;
  the API sends it to the portal and keeps nothing. The session token that comes back is sealed (AES-256-GCM, `SECRETS_KEY`,
  bound to the organisation) and kept only for the portal's session (about six hours); expiry or signing out forgets it. No
  password is stored, and nothing starts an OTP flow by itself.
- **Saving is not filing.** `pushGstr1` saves a return's tables on the portal (replacing the period's earlier save); the
  taxpayer files on the portal with a DSC or EVC. The adapter has `canFile = false`; the desk shows the steps and the
  figures to compare, and "Check if filed" (and a 30-minute scheduler for returns saved or exported but not filed) picks the
  ARN up and moves the return to `filed`. When both GSTR-1 and GSTR-3B of a period are filed the period is locked.
- **Jobs.** A job per business, kind (push, pull 2B, pull 2A, poll filing), form and period; one live job at a time (unique
  index), so asking again returns the running one. A job that needs a login waits (`waiting_otp`), never retries blindly, and
  leaves an inbox card. A job that fails leaves the local state unchanged: the desk moves to `pushed` only when the portal
  has every table.
- **Push is idempotent twice over.** A file identical to the last successful push is not sent (the job says "unchanged"), and
  the portal's save replaces a period. The same gates as the desk's own export apply first: problems standing block the push,
  and the file must pass its own schema check.
- **Per-table results.** The portal's answer is kept per table with each refused item's code, message and reference; some
  refused is `partial` with one card naming the tables, and the books are not advanced.
- **2B** is parsed by the existing versioned parser and imported through the same repository the manual import uses, then the
  reconciliation summary (matched, differences, only on the portal, credit at stake) is stored on the job. **2A** is
  summarised for reference and not reconciled (credit is decided on 2B).
- **Metering.** Every call to the portal is a `usage_events` row (`gsp_call`) against `limits.gspCalls`; one past the limit is
  refused before it is made.
- **Late fee, nil and QRMP** are pure domain functions with tests (`filing-rules.ts`): an estimate by turnover band with the
  rule version in the result; a nil GSTR-1 file; IFF months 1 and 2 of a quarter (B2B and credit/debit notes only) due the
  13th. The rates are typed from the Act and not CA-reviewed (B-202).
- **The CA board** reads every organisation the account is a member of where the role may view GST returns, each under its
  own row-level security: a cell per period and return (filed, saved, exported, overdue, not yet due), and exceptions
  (overdue, problems waiting, input credit not reconciled above a threshold). Sharing a client with a CA who is not a member
  arrives with prompt 47.

## Not done

No vendor sandbox was available, so a real GSTR-1 push and 2B pull were not run (`docs/compliance/gsp-sandbox-run.md`); the
vendor adapter is a scaffold with `TODO(vendor)` guesses. GSTR-3B is exported, not saved. Owner reminders for returns coming
due, retries of transient portal errors, and a supplier-level 2A view are not built. See B-201 to B-208.
