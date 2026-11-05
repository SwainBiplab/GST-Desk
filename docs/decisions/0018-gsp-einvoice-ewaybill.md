# 0018 — GSP adapter, e-invoice (IRN) and e-way bill

Status: accepted. Context: prompt 32, `phase-2/32-gsp-adapter-einvoice-ewaybill.md`. Review sheet: `docs/compliance/einvoice-review.md` (unsigned). Sandbox run: `docs/compliance/einvoice-sandbox-run.md` (**not done**). Builds on ADR 0016 and 0017.

## Decisions

### 1. One adapter interface; the vendor is a detail

`packages/gsp` defines `GspAdapter` (authenticate, generateIrn, cancelIrn, getIrnByDocument, generateEwb, updateVehicle, extendEwb, cancelEwb, getEwb, pushGstr1, pullGstr2b). Nothing else in the app knows which vendor is in use. Two implementations ship: `MockGspAdapter` (the "practice" portal, used by every test and by practice mode in the app) and `VendorXAdapter`, a generic REST scaffold with `TODO(vendor)` markers where a real GSP's paths and field names go. The two GSTR calls throw `GD-NOT-YET` until prompt 46.

### 2. The database layer never sees credentials or a vendor

`EinvoiceRepo` takes any object with the `GspPort` methods. `@gst/gsp` is a dev dependency of `@gst/db` (for tests) and a dependency of `web` only. The web app builds the client (`features/einvoice/session.ts`), so credentials live in the browser's memory and nowhere else.

### 3. Credentials are sealed with a PIN and unsealed in memory only

PBKDF2-SHA256 (310,000 rounds) derives an AES-256-GCM key from a PIN of at least six characters. The sealed blob is saved as the secret setting `secret.gsp.credentials`, which the backup excludes and the audit log redacts. The PIN is never stored; a wrong PIN is told apart from a damaged blob (GCM fails, `WrongPinError`). "Lock now" and closing the app forget the unsealed copy; requests wait in the queue without losing attempts. The desktop keychain is a later step (backlog B-114): a PIN works in the browser and on the desktop alike.

### 4. A payload is built from the document, checked, and only then queued

`buildEinvoice` writes the NIC schema 1.1 JSON from our document; `checkEinvoice` lists what the portal would refuse (document number format, dates, GSTIN, address and pincode, HSN digits by turnover, rate list, tax recomputed in BigInt against the line, heads for inter or intra state, round-off, totals, preceding document for notes, export rules). A request with problems is not queued; the screen lists each with its path in the payload. The rules are data (`data/einvoice/rules-v1_1.ts`, `data/ewb-rules.ts`) with `verified: false` until someone checks them against the live portal.

### 5. The queue is the only way to talk to the portal

`gsp_jobs` holds every request. The idempotency key is `kind : document : revision : hash(arguments)`, so asking twice gives the same job. `process` sends due jobs oldest first:

- A job whose document changed after it was queued is **stopped**, never sent, and an inbox card (`gsp_job_stopped`) says so. Nobody has a wrong IRN because they edited a draft in the middle of a queue.
- A retryable failure (offline, timeout, locked, expired login) goes back to `queued` with a back-off of 1, 5, 15, 60, 180 and 360 minutes; anything else is `failed` with the portal's code kept for the plain-language explanation.
- A job found `running` after five minutes was interrupted. An IRN request is simply sent again (the portal answers 2150 for a duplicate and the client turns that into the IRN that already exists, marked `recovered`); any other kind fails with `GD-UNCERTAIN` rather than risk doing it twice.

### 6. The portal's errors become sentences, as data

`data/gsp-errors.ts` maps codes (and our own `GD-*` codes) to `{plain, next, retry}`. An unknown code still gets a sentence and keeps the portal's own message beside it. A person never sees only `2150`.

### 7. After an IRN the document is frozen, by the database, not the screen

`DocumentFlowRepo` refuses a financial revision and a plain cancellation of a document with an active IRN (non-financial edits such as notes are still allowed). The way out is exactly the legal one: cancel the IRN within 24 hours (the document is cancelled with it) or issue a credit note. After 24 hours the screen says "Issue a credit note instead". An IRN cannot be cancelled while an active e-way bill hangs from it (code 2230, mirrored in the practice portal).

### 8. Every call is logged, and the log is redacted by key name

`GspClient` writes every call to `gsp_log` through `redact`, which replaces the value of any key matching `pass(word)`, `secret`, `token`, `sek`, `app_key`, `otp` or `credential`. It deliberately does not match `pin`: the payload's `Pin` is a pincode. A test reads the whole log back and asserts that no password and no token is in it.

### 9. The editor reads the document again when the queue changes it

The queue records an IRN (or its cancellation) outside the editor. The first end-to-end run showed the open editor still saying "Issued" after a cancellation and still offering Revise after an IRN. `useEditor.refresh()` re-reads an issued document, and the editor calls it when the document's e-invoice row changes (not while a revision is being edited).

### 10. Practice mode is the default, says so on every screen, and remembers

With no credentials the app uses the practice portal. It keeps what it issued in `localStorage` (`MockGspAdapter.state()`), so cancelling after a reload finds the IRN. Every panel says nothing is sent to the GST portal. The first real GSP is configured in Settings, GST portal, with an https address (anything else is refused).

### 11. The demo book now has addresses

The portal refuses a document without a seller address and a buyer pincode, and the demo book had neither, so every demo invoice failed the check (correctly). The seed now gives the business an address and each party a billing address derived from its number (not drawn, so no other demo value changed).

## Performance (measured)

| What                                                       | Result           | Budget |
| ---------------------------------------------------------- | ---------------- | ------ |
| Build and check 1,000 invoices of 10 lines (domain, node)  | 31 ms            | 1 s    |
| Queue one IRN request (sqlite, includes the payload check) | 7.1 ms           | 500 ms |
| Send one queued IRN against the practice portal (sqlite)   | 6.6 ms           | 500 ms |
| The same two on Postgres                                   | 14.5 ms, 14.6 ms | 500 ms |

The portal's own latency is not ours: a real GSP answers in a second or two, and the queue sends one request at a time (a later step can send a few at once; backlog B-115).

## Not done, on purpose

- **No real portal was reached.** The acceptance criterion of a vendor sandbox run needs credentials from Leader Group. It is recorded as open in `docs/compliance/einvoice-sandbox-run.md` and B-111 [GA blocker].
- The NIC field list, the error codes and the e-way bill rules come from public documentation and are marked `verified: false`.
- Pulling GSTR-2B and pushing GSTR-1 through the GSP are prompt 46.
