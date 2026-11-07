# 0024 — Sync, merges and document numbers across devices

Status: accepted by engineering; **the numbering part needs a CA's sign-off** (backlog B-170).
Context: prompt 41, PRD FR-130, FR-044, UX-10, NFR-08; CGST Rules 46 and 48, GSTR-1 Table 13.

## Decision: sync

- **PowerSync downloads, the API uploads.** The PowerSync service (open edition, self-hosted beside the API)
  replicates Postgres by logical replication and streams each device the buckets its token allows: one bucket
  per business of the organisation in the token, one for the organisation's own rows, one shared bucket for
  the HSN master. The rules are generated from `packages/db/src/sync/spec.ts` (`infra/powersync/sync-rules.yaml`),
  the same spec the server's write path and the device's upload connector read. Devices never write to the
  service: they upload to `/v1/sync/write`, where the API checks and applies. Postgres is the source of truth.
- **Our own tables on the device.** PowerSync's "raw tables" put synced rows straight into our schema, with its
  constraints, indexes and search triggers, through upserts (so update triggers fire); local writes are queued by
  triggers PowerSync generates, with the previous `version` and `updated_at` of each changed row. The
  repositories in `@gst/db` run unchanged over the PowerSync connection (`@gst/sync/node`, Drizzle's PowerSync
  driver). The local guards (no hard delete, append-only audit) stand aside only while PowerSync itself writes,
  because putting the server's state back can mean removing a row the server refused.
- **The token decides what a device sees.** The API signs an HS256 token (organisation, user, device, role,
  five minutes) only after checking membership; the sync rules read the organisation from it. Logical replication
  does not pass through row-level security, so the rules, not RLS, keep organisations apart on the way down;
  every upload still goes through RLS on the way up.
- **What syncs.** Every business table both ways, except: people and organisations (server-side), LAN tablets
  with their token hashes, per-device state, the AI call log and vectors (rebuilt per device), and secret
  settings (dropped by the device and refused by the server). `audit_log` only takes new rows.

## Decision: merges

A transaction from a device (a draft save is one: the document and its lines) is applied whole or not at all.

- **On top of what the server holds** (the row's previous version and time on the device equal the server's):
  applied as it is.
- **Someone else changed the row since:** fields that are not money (names, phones, notes, terms) merge column
  by column, last writer wins. Money and identity of a draft, two devices issuing the same draft, a revision
  racing a cancellation, or a change to a row the server never got make the whole transaction a **conflict**:
  nothing is applied, and a `sync_conflict` inbox item keeps the server's version and mine side by side with the
  whole transaction. _Keep my version_ applies mine on top; _keep theirs_ closes it. Nothing is lost either way.
- **Deleting a draft wins over an edit only if the edit is older**; a draft discarded here but issued elsewhere
  stays issued and the discard becomes a conflict.
- **Issued documents:** money and identity change only by a revision (`revision` up by one, lines with it in the
  same transaction); a cancelled document never. A device that changes them otherwise is refused, and the
  server's version is sent back down.
- **Money is the engine's.** Every document issued or revised in an upload is priced again with `buildDocument`;
  a total the engine does not agree with refuses the transaction. A draft at rest, or a document arriving
  already issued (a business being converted, history from an import or an earlier engine), must agree with
  itself (each head of tax with its rate, the totals with the lines).
- **Retries are harmless.** `(device, transaction)` is recorded; a retried upload gets the same answer.
- **A refusal is never silent.** The device records every outcome; the status sheet shows them. The server
  rewrites the rows involved unchanged so the stream carries its version back, and PowerSync replaces the
  device's copy.

## Decision: numbers (FR-044) — for the CA

Rule 46(b) asks for "a consecutive serial number, not exceeding sixteen characters, in one or multiple series ...
unique for a financial year". Two devices offline cannot both take "the next number" of one counter. Options:

1. **A series per device** (prefix `A/`, `B/`): always valid offline, no gaps, no renumbering. Costs: more series
   to report in GSTR-1 Table 13 and a prefix per counter.
2. **Ranges of one series per device** (chosen as the default): the server hands each device a block (default 50)
   of the series it issues from; offline it issues from its block, consecutive within the block. The numbers
   are unique by construction. Costs: numbers are not in date order across devices, and an unused tail of a
   block is a gap until it is released and reused.
3. **Provisional numbers** when a device's block runs out offline: `PROV-<device>-0001`. A provisional document is
   **not a tax invoice**: the app will not print or share it, and it shows a "Provisional number" badge. On sync
   the server gives it the next real number of its series, keeps its date, and writes the mapping to the audit
   trail. Costs: the real number is given after the date of the document.

The app uses 2 and falls back to 3. A business that issues offline for long stretches should use 1 (a series
per counter, a setting that exists today). **Questions for the CA:** is a number given after the document's date
(option 3) acceptable when the customer has not yet been given the document; how should released block tails
(option 2) be shown in Table 13; is option 1 the advice for a shop with several offline counters.

## Consequences and what is not done

- Tested against the real service (Testcontainers: Postgres with logical replication, PowerSync, the API in
  process, devices as PowerSync clients over SQLite): two devices, downloads and uploads, offline numbering with
  ranges and provisional numbers, merges, conflicts, a delete racing an edit, a tampered total, converting the
  500-document demo book to synced and back. The chaos test passed **100 runs** (2,400 random operations,
  2,231 uploaded transactions: 1,827 applied, 404 kept as conflicts, none refused; every run converged with real,
  unique numbers). See `docs/perf/sync.md`.
- **The browser and the desktop app do not run the sync client yet.** The browser keeps its database in
  `@sqlite.org/sqlite-wasm`, which cannot load PowerSync's SQLite extension; the desktop's database is reached
  through Rust. Synced books therefore run, today, in Node (tests, tooling). The status pill, its sheet and the
  conflict card are built and tested against a status store the client will feed (B-167, B-168, GA blockers).
- Initial sync: 8.1 KB per document uncompressed (167 s for 50,000 documents at 20 Mbps), 0.8 KB gzipped (16 s).
  The 2-minute budget holds only with compression on the stream (the proxy in front of the service); measured on
  the 500-document demo and extrapolated, not on a 50,000-document book over a 20 Mbps link (B-171).
- Attachments: rows sync; bytes move through signed URLs by a queue that uploads once, downloads and checks the
  hash, and backs off on failure (tested with a fake store; wiring it to the browser's file store is B-169).
