# Runbook: sync

## Turning it on for a server

1. Postgres needs `wal_level=logical` (the compose files set it; a managed Postgres has a setting for it) and the
   storage database for the service (`infra/powersync/init-storage.sql`).
2. Run the PowerSync service with `infra/powersync/powersync.yaml` and `sync-rules.yaml` (both compose files do).
3. Set `POWERSYNC_URL` (its public https address) and `POWERSYNC_JWT_SECRET` on the API, and the same secret in
   base64url as `PS_JWT_SECRET_B64URL` on the service. Put both behind the TLS proxy with gzip on.
4. The API's migration `0005_sync` makes the publication the service replicates from.

After a schema change: `pnpm --filter @gst/db exec tsx scripts/sync-rules.ts > infra/powersync/sync-rules.yaml`
and restart the service (it re-replicates).

## A business

- New books are **local only**. Converting uploads the whole business (each document with its lines in one
  transaction) and marks it synced; from then on devices take numbers from blocks the server hands out.
- Leaving sync copies the business back into a standalone local book.

## When something is wrong

| Symptom                                  | Likely cause                                                               | Do this                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Pill says _Offline_ with changes waiting | No network, or the token could not be fetched                              | Changes are safe on the device; they go up when it reconnects                           |
| Pill says _Sync stuck_                   | The server keeps failing an upload                                         | The sheet shows the error; the API log has the request id                               |
| _Conflicts_                              | Two devices changed the same thing while apart                             | Inbox: compare, then _Keep my version_ or _Keep theirs_                                 |
| A document shows _Provisional number_    | Issued offline after the device's block ran out                            | Connect; the server gives it its real number. It cannot be printed or shared until then |
| A device sees nothing                    | The service has not loaded its rules, or the token's organisation is wrong | Service log: "Activated new replication stream"; `/v1/sync/token` answer                |

## Before relying on it

The browser and desktop apps do not run the sync client yet (B-167, B-168). Have a CA sign the numbering ADR
(`docs/decisions/0024-sync-and-offline-numbering.md`, B-170).
