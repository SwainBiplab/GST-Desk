-- The cloud AI gateway's batch path (prompt 48): many extractions or categorisations sent to the model provider as
-- one Message Batch, polled by a queue job until it ends, the results checked and kept here. Items hold what was
-- sent (text already read on the device) and what came back; nothing is logged elsewhere.
CREATE TABLE IF NOT EXISTS ai_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('extract_bills', 'categorise_statement')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitted', 'done', 'failed')),
  provider_batch_id text,
  items_json jsonb NOT NULL,
  results_json jsonb,
  counts_json jsonb,
  error text,
  polls integer NOT NULL DEFAULT 0,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  finished_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_batches_business_idx ON ai_batches (org_id, business_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE ai_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_batches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_batches USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_batches TO gst_app;
