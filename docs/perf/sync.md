# Sync: chaos runs and initial sync

## Chaos (acceptance: 100 runs)

`CHAOS_RUNS=100 pnpm --filter api exec vitest run test/sync-chaos.test.ts` on 2026-11-07, against Postgres 16 with
logical replication, the PowerSync service (`journeyapps/powersync-service`), the API in process and two devices
(PowerSync Node clients over SQLite with the full schema). Each run: a new business, two shared customers, three
shared drafts and a small block of numbers per device; both devices go offline and do 24 random operations
between them (new and changed customers, new and changed drafts, issuing, cancelling, discarding); then they
reconnect in a random order.

|                       |                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs                  | 100, all passed (185 s)                                                                                                                                     |
| Operations            | 2,400: 441 draft edits, 342 issues, 200 cancellations, 308 discards, 499 customer edits, 269 new drafts, 172 new customers, 169 skipped (nothing to act on) |
| Uploaded transactions | 2,231: 1,827 applied, 404 conflicts (kept in the inbox with both versions), 0 refused                                                                       |
| After every run       | no provisional number left, no two documents with one number, both devices hold exactly the server's rows and versions for the business                     |

The normal test suite runs 5 runs; set `CHAOS_RUNS` for more.

Found and fixed by the chaos runs: a refused database write retried forever (now a recorded refusal); a draft
discarded on one device and issued on another (now a conflict); version numbers coinciding across devices (the
server now compares the previous version and time the device sends); a change to a row the server never got,
queued behind a conflict (now a conflict, so it is kept, not refused).

## Initial sync

Measured on the 500-document demo book converted to synced and downloaded by a fresh device:

|                      |                                                                             |
| -------------------- | --------------------------------------------------------------------------- |
| Rows                 | 5,667 (documents, lines, ledger, stock, payments, parties, items, settings) |
| Stream, uncompressed | 4.17 MB, 8.1 KB per document with its rows                                  |
| Stream, gzip         | 0.40 MB, 0.8 KB per document                                                |
| Apply on the device  | 0.5 s (local machine, no network)                                           |

Extrapolated to 50,000 documents at 20 Mbps: 167 s of transfer uncompressed, 16 s with gzip, plus about 50 s to
apply. **The 2-minute budget needs compression on the stream** (gzip at the proxy in front of the service). Not yet
measured on a real 50,000-document book over a real 20 Mbps link (B-171).
