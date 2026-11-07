-- Messaging (prompt 44): what a business sends to its customers from the cloud tier. Templates per
-- language with the status Meta holds, the rules for when to send, who has agreed to be written to, every
-- message with its timeline, the recurring invoices the server makes, and the webhook events already seen.
CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  kind text NOT NULL CHECK (kind IN ('invoice', 'receipt', 'reminder')),
  language text NOT NULL CHECK (language IN ('en', 'hi', 'ta', 'mr', 'bn', 'gu')),
  name text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'paused')),
  meta_id text,
  reason text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_key_idx ON message_templates (org_id, kind, language);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS dispatch_settings (
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  on_issue jsonb NOT NULL DEFAULT '{}'::jsonb,
  on_payment boolean NOT NULL DEFAULT false,
  reminders boolean NOT NULL DEFAULT false,
  offsets jsonb NOT NULL DEFAULT '[-3, 0, 7, 15]'::jsonb,
  quiet_start text NOT NULL DEFAULT '21:00',
  quiet_end text NOT NULL DEFAULT '09:00',
  auto_send jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel text NOT NULL DEFAULT 'whatsapp_first' CHECK (channel IN ('whatsapp_first', 'email_first', 'whatsapp', 'email')),
  default_language text NOT NULL DEFAULT 'en',
  updated_at bigint NOT NULL,
  PRIMARY KEY (org_id, business_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS party_consent (
  org_id uuid NOT NULL REFERENCES organisations(id),
  party_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
  source text NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (org_id, party_id, channel)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS message_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  party_id uuid,
  document_id uuid,
  payment_id uuid,
  kind text NOT NULL CHECK (kind IN ('invoice', 'receipt', 'reminder')),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  to_address text NOT NULL,
  language text NOT NULL,
  template_name text NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body text NOT NULL,
  approval text NOT NULL CHECK (approval IN ('pending', 'approved', 'auto', 'rejected')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'opened', 'failed', 'bounced')),
  provider_id text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  dedupe_key text NOT NULL,
  not_before bigint,
  created_by text,
  decided_by text,
  decided_at bigint,
  sent_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS message_log_dedupe_idx ON message_log (org_id, dedupe_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_log_party_idx ON message_log (org_id, party_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_log_document_idx ON message_log (org_id, document_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_log_provider_idx ON message_log (provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_log_pending_idx ON message_log (org_id, approval, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS message_events (
  id uuid PRIMARY KEY,
  seq bigserial,
  org_id uuid NOT NULL REFERENCES organisations(id),
  message_id uuid NOT NULL REFERENCES message_log(id),
  status text NOT NULL,
  detail text,
  at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_events_message_idx ON message_events (message_id, at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_events (
  event_key text PRIMARY KEY,
  provider text NOT NULL,
  at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  name text NOT NULL,
  source_document_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  every integer NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 12),
  day_of_month integer NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  next_run text NOT NULL,
  end_date text,
  due_days integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  send boolean NOT NULL DEFAULT false,
  last_run_at bigint,
  last_document_id uuid,
  last_error text,
  runs integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_invoices_due_idx ON recurring_invoices (active, next_run);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates', 'dispatch_settings', 'party_consent', 'message_log', 'message_events', 'recurring_invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'')::uuid) WITH CHECK (org_id = current_setting(''app.org_id'')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER message_log_no_delete BEFORE DELETE ON message_log FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
--> statement-breakpoint
CREATE TRIGGER message_events_no_delete BEFORE DELETE ON message_events FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON message_templates, dispatch_settings, party_consent, message_log, message_events, webhook_events, recurring_invoices TO gst_app;
--> statement-breakpoint
-- A provider's webhook names a message, not an organisation: this view (owned by the migration user, like
-- the operator views) finds the organisation to set before the message itself is read.
CREATE OR REPLACE VIEW message_provider_ids AS SELECT provider_id, org_id, party_id, channel, to_address FROM message_log WHERE provider_id IS NOT NULL;
--> statement-breakpoint
-- Meta names a template, not an organisation, in its approval webhook.
CREATE OR REPLACE VIEW message_template_names AS SELECT name, org_id, language FROM message_templates;
--> statement-breakpoint
GRANT SELECT ON message_template_names TO gst_app;
--> statement-breakpoint
GRANT SELECT ON message_provider_ids TO gst_app;
