-- The PowerSync service keeps its bucket storage in its own database next to the books.
-- Run once against a new Postgres (the API's migrations do not create databases):
--   psql "$DATABASE_URL" -f infra/powersync/init-storage.sql
SELECT 'CREATE DATABASE powersync_storage' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'powersync_storage')\gexec
