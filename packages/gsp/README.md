# @gst/gsp

The GSP (GST Suvidha Provider) adapter: everything GST Desk asks of a vendor to make e-invoices (IRN) and e-way bills. See `docs/decisions/0018-gsp-einvoice-ewaybill.md`.

| File              | What it is                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`    | `GspAdapter`, `GspCredentials`, `GspSession`, `GspError(code, message, detail?)`                                                                                                                         |
| `src/client.ts`   | `GspClient`: logs in once per portal and reuses the token until 60 s before it ends, retries once after a refused login, turns a duplicate IRN (2150) into the IRN that exists, logs every call redacted |
| `src/mock.ts`     | `MockGspAdapter`: the practice portal; keeps its memory with `state()`                                                                                                                                   |
| `src/vendor-x.ts` | `VendorXAdapter`: a generic REST scaffold; search for `TODO(vendor)`                                                                                                                                     |
| `src/crypto.ts`   | `sealCredentials` and `openCredentials` (PBKDF2-SHA256, 310,000 rounds, AES-256-GCM)                                                                                                                     |
| `src/redact.ts`   | `redact`: removes passwords, secrets and tokens from anything logged                                                                                                                                     |

## Add a real vendor

1. Copy `vendor-x.ts` to `vendor-<name>.ts`. Implement each method against the vendor's documentation. Throw `GspError(code, message, detail)` with the **portal's own error code** when the portal refuses (the plain-language text is looked up by code in `packages/domain/data/gsp-errors.ts`; add the vendor's codes there).
2. Map `AbortError` and network failures by letting them through: `GspClient` turns a `TypeError` into `GD-OFFLINE` and an `AbortError` into `GD-TIMEOUT`.
3. Wire it in `apps/web/src/features/einvoice/session.ts` (`clientFor`) and add the mode to `GspConfig` in `packages/db/src/repositories/einvoice.ts` and the mode list in Settings, GST portal.
4. Run it against the vendor's sandbox and record the run in `docs/compliance/einvoice-sandbox-run.md`. Until that is signed, practice mode stays the default.

## Rules for adapters

- Never log a credential or a token. `GspClient` redacts what it logs, but an adapter that throws an error containing a password in its message defeats it.
- A method that changes something at the portal must be safe to call again, or the portal must answer a repeat with a code the client can recover from (as 2150 for an IRN).
- Return what the portal returned; do not tidy dates. The IST stamps are stored as given.

## Tests

`pnpm --filter @gst/gsp test`. The suite runs the client against the practice portal: IRN generation, duplicate recovery, token expiry, 24-hour cancellation, e-way bill generation, extension and cancellation, sealing and redaction.
