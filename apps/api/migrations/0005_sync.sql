-- Sync (prompt 41). The publication PowerSync replicates from (it needs wal_level=logical; a managed
-- Postgres turns that on in its settings), the devices that sync, and the uploads already applied so a
-- retried upload is applied once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    CREATE PUBLICATION powersync FOR ALL TABLES;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_devices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  user_id text NOT NULL,
  name text NOT NULL,
  platform text,
  created_at bigint NOT NULL,
  last_seen_at bigint,
  revoked_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_devices_org_idx ON sync_devices (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_applied (
  device_id uuid NOT NULL,
  client_tx_id bigint NOT NULL,
  org_id uuid NOT NULL,
  outcome text NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (device_id, client_tx_id)
);
--> statement-breakpoint
ALTER TABLE sync_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sync_devices USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE sync_applied ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_applied FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sync_applied USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_devices, sync_applied TO gst_app;
