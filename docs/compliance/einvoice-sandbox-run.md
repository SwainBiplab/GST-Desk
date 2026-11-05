# e-Invoice and e-way bill: sandbox run

**Status: NOT DONE.** The acceptance criterion of prompt 32 is a run against a GSP's sandbox, with credentials from Leader Group (API users on the e-invoice and e-way bill sandbox portals, and the GSP's client id and secret). Those credentials were not available, and no real portal has been contacted by this software. Everything that passes today passes against the practice portal (`MockGspAdapter`), which was written from the same public documentation as the code under test, so agreement between the two proves the code is consistent, **not** that it is right.

Tracked as backlog **B-111 [GA blocker]**.

## What is needed

1. A GSP with a sandbox, chosen by Leader Group; its REST documentation. Implement `packages/gsp/src/vendor-<name>.ts` from `vendor-x.ts` (see `packages/gsp/README.md`).
2. Sandbox API users for the test GSTIN, on both portals, and the GSP's client id and secret.
3. A test GSTIN registered on the sandbox, matching a business in the app (the sandbox accepts only its own test GSTINs).
4. In the app: Settings, GST portal, choose the GSP, enter its address, tick Sandbox, save the logins with a PIN, unlock.

## The run (fill in as it happens)

| Step | Expected                                                                                             | Result | Date | By  |
| ---- | ---------------------------------------------------------------------------------------------------- | ------ | ---- | --- |
| 1    | Log in: a token comes back; a second call reuses it                                                  |        |      |     |
| 2    | Generate an IRN for a B2B invoice: IRN, ack no. and ack date set                                     |        |      |     |
| 3    | The signed QR on the printed invoice scans on the portal's tool                                      |        |      |     |
| 4    | Generate the same document again: 2150 is recovered                                                  |        |      |     |
| 5    | Generate for a credit note against it                                                                |        |      |     |
| 6    | Cancel an IRN at under 24 h                                                                          |        |      |     |
| 7    | Generate an e-way bill with distance 0 (portal works it out)                                         |        |      |     |
| 8    | Change the vehicle; extend inside the 8-hour window; cancel                                          |        |      |     |
| 9    | Switch off the network mid-request: the request waits and then goes through once, with no second IRN |        |      |     |
| 10   | Read `gsp_log`: no password, token or secret appears                                                 |        |      |     |

## Differences found

(none yet; add each with the payload field or code, and the fix, here and in `rules-v1_1.ts` or `gsp-errors.ts`. Set `verified: true` in the data files only when every step above has passed.)
