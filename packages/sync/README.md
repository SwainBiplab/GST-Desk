# @gst/sync

The device side of sync (prompt 41): PowerSync with "raw tables" over our own schema, so the repositories in
`@gst/db` run unchanged on a synced book.

- `node.ts`: `openSyncedBook` (PowerSync's Node client over SQLite, our migrations, the upload triggers with the
  previous version and time of each row, the local guards relaxed only for PowerSync's own writes).
- `tables.ts`: the raw-table definitions (upserts into our tables) from `@gst/db`'s sync spec.
- `connector.ts`: the API side: a token for the service, uploads of queued transactions (outcomes kept in
  `sync_outcomes`), number ranges; secret settings never leave.
- `ranges.ts`: keep a block of numbers of each type this device issues.
- `convert.ts`: copy a local business into a synced book (each document with its lines in one upload), and back.
- `attachments.ts`: the file queue (signed URLs, hash checked, backoff).

The browser and the desktop do not use this yet (B-167, B-168). Tests that use it live in `apps/api/test`
(`sync.test.ts`, `sync-chaos.test.ts`) because they need the API and the service. See
`docs/decisions/0024-sync-and-offline-numbering.md`.
