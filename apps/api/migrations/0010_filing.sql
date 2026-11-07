-- GST filing through the GSP (prompt 46): the taxpayer's login to the return portal (an OTP they type, kept only as a
-- session token sealed under the platform key, for as long as it lives), and the jobs that save a return on the portal,
-- pull GSTR-2B and 2A, and ask whether a return has been filed.
CREATE TABLE IF NOT EXISTS gstn_sessions (
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  gstin text NOT NULL,
  username text NOT NULL,
  token_enc text,
  expires_at bigint,
  otp_txn_id text,
  otp_expires_at bigint,
  updated_by text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (org_id, business_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS filing_jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('push', 'pull_2b', 'pull_2a', 'poll_filing')),
  -- push: gstr1 or iff. poll_filing: gstr1 or gstr3b.
  form text,
  period_fp text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_otp', 'processing', 'done', 'partial', 'failed')),
  reference text,
  payload_hash text,
  result_json jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
-- one live job per business, kind, form and period: asking again returns it
CREATE UNIQUE INDEX IF NOT EXISTS filing_jobs_live_idx ON filing_jobs (org_id, business_id, kind, coalesce(form, ''), period_fp)
  WHERE status IN ('queued', 'running', 'processing', 'waiting_otp');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS filing_jobs_business_idx ON filing_jobs (org_id, business_id, created_at DESC);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gstn_sessions', 'filing_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'')::uuid) WITH CHECK (org_id = current_setting(''app.org_id'')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON gstn_sessions, filing_jobs TO gst_app;
--> statement-breakpoint
-- The scheduler asks which businesses have a login on the portal; it reads this before it knows an organisation.
CREATE OR REPLACE VIEW gstn_session_orgs AS SELECT org_id, business_id FROM gstn_sessions WHERE token_enc IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON gstn_session_orgs TO gst_app;
