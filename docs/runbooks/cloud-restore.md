# Runbook: restore the cloud database

The `backup` service in `infra/compose.prod.yml` runs `infra/backup.sh` every day at 02:00 IST: a
`pg_dump` in custom format, uploaded to `backups/postgres/gst-<stamp>.dump` in the bucket, tagged
`kind=backup` so the bucket's lifecycle rule expires it after 30 days.

## Restore to a new database (the normal way)

1. Stop the API: `docker compose -f infra/compose.prod.yml stop api backup`.
2. Fetch the dump: with the MinIO console (`:9001`) or `mc cp local/gstdesk/backups/postgres/<file> .`.
3. Make an empty database beside the live one:
   `docker compose -f infra/compose.prod.yml exec postgres createdb -U $PG_OWNER_USER gst_restore`.
4. Load: `docker compose -f infra/compose.prod.yml exec -T postgres pg_restore -U $PG_OWNER_USER -d gst_restore --no-owner --no-privileges < <file>`.
5. Check: `psql -d gst_restore -c "select count(*) from documents"` and a few organisations you know.
6. Swap: rename `gst` to `gst_old_<date>` and `gst_restore` to `gst` (`ALTER DATABASE ... RENAME TO ...`, with
   no connections open), then start the API. It runs the migrations on start and refuses to start if the
   schema is newer than the code.
7. The app role: `pg_restore --no-privileges` drops the grants; the API's migration `0003_app_role` is
   recorded as applied, so re-grant by hand once:
   `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gst_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gst_app;`
8. Keep `gst_old_<date>` for a week, then drop it.

## Point-in-time

Not provided by the daily dump. For a managed Postgres, turn on the provider's point-in-time recovery; for
the compose stack, add WAL archiving (`archive_command` to the bucket) when the business needs it (B-164).

## Object storage

Attachments and PDFs live in the bucket, not in the database; a database restore does not touch them. A
bucket restore is the provider's versioning or a second bucket in another region (`mc mirror`), set up at
deployment time.

## Try it before you need it

Quarterly: restore last night's dump into `gst_restore` on the same host, run the count checks, drop it.
Record the date in the operations log.
