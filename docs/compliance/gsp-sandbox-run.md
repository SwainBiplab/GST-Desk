# GSP sandbox run (GSTR-1 push and GSTR-2B pull)

**Status: NOT RUN.** This needs a GSP vendor's sandbox (its base URL, client credentials, a test GSTIN with a portal user
and a phone that receives the OTP) and the vendor's documentation. None was available when prompt 46 was built. Nothing
below is a result. The automated tests use the in-memory practice portal; the vendor adapter is a scaffold that has never
met a vendor (`packages/gsp/src/vendor-x.ts`, `TODO(vendor)`).

Acceptance (prompt 46): with a vendor sandbox, one GSTR-1 push and one 2B pull succeed and are recorded here.

## Needs

`GSP_BASE_URL`, `GSP_SANDBOX=true`, `SECRETS_KEY`, a business with the test GSTIN and a synced invoice or two in a
period, the cloud plan, and a phone for the OTP.

## Steps

| #   | Step                                                                                                                                                   | Result  | Run by / date |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------- |
| 1   | Filing Desk: enter the portal user name, send the OTP, type it; the card says signed in                                                                | not run |               |
| 2   | Open a period, GST portal tab, Save GSTR-1; the job goes Done and each table shows its count                                                           | not run |               |
| 3   | Check on the sandbox portal that the saved tables match (counts and values)                                                                            | not run |               |
| 4   | Save again unchanged: the job says nothing changed and no call is made                                                                                 | not run |               |
| 5   | Make one invoice the portal refuses; the job shows Part refused with its code and the desk is not advanced                                             | not run |               |
| 6   | Pull GSTR-2B for the period; the job reports imported, matched, differences and only-on-portal                                                         | not run |               |
| 7   | Let the OTP session lapse; the next job says it needs an OTP and leaves a card                                                                         | not run |               |
| 8   | File the return on the sandbox portal; Check if filed brings in the ARN and marks it filed                                                             | not run |               |
| 9   | Replace each `TODO(vendor)` guess in the adapter with what the vendor documents (paths, headers, per-table error shape, status values, session length) | not run |               |
