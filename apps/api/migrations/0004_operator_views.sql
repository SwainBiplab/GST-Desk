-- Operators read usage across organisations through a view owned by the migration user, which runs with
-- the owner's rights and so is not subject to the tenant policy. It is aggregated metering, never books.
CREATE OR REPLACE VIEW usage_events_all AS SELECT id, org_id, business_id, kind, quantity, ref, at, created_at FROM usage_events;
--> statement-breakpoint
GRANT SELECT ON usage_events_all TO gst_app;
