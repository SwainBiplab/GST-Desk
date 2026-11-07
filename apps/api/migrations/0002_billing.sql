-- Billing hooks: plans, an organisation's subscription, and metered usage. No payment collection yet; the
-- usage rows feed the pricing decision. Tenant rows carry org_id and the same RLS policy as the shared schema.
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price_paise_month bigint NOT NULL DEFAULT 0,
  limits_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
INSERT INTO plans (id, name, price_paise_month, limits_json, created_at, updated_at) VALUES
  ('free', 'Free local', 0, '{"businesses": 3, "members": 1, "gspCalls": 0, "messages": 0, "aiTokens": 0}', 0, 0),
  ('cloud', 'Cloud', 0, '{"businesses": 10, "members": 10, "gspCalls": 1000, "messages": 1000, "aiTokens": 2000000}', 0, 0)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  plan_id text NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  started_at bigint NOT NULL,
  renews_at bigint,
  cancelled_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  version integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_idx ON subscriptions (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid,
  kind text NOT NULL CHECK (kind IN ('gsp_call', 'message', 'ai_tokens', 'pdf_render', 'storage_bytes')),
  quantity bigint NOT NULL,
  ref text,
  at bigint NOT NULL,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_events_org_at_idx ON usage_events (org_id, at);
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscriptions USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_events USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
