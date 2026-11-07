-- Payment collection (prompt 45): each business connects its own gateway account (keys sealed under the
-- platform key), asks it for a link or a UPI QR per invoice, and the gateway's webhooks say when the money
-- came. A gateway payment is one row per provider payment id, which is what makes a replayed webhook change
-- nothing. Settlements and refunds are tracked beside them.
CREATE TABLE IF NOT EXISTS payment_gateways (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('razorpay', 'mock')),
  key_id text NOT NULL,
  key_secret_enc text NOT NULL,
  webhook_secret_enc text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  active boolean NOT NULL DEFAULT true,
  last_error text,
  last_ok_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_gateways_business_idx ON payment_gateways (org_id, business_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS payment_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  gateway_id uuid NOT NULL REFERENCES payment_gateways(id),
  document_id uuid NOT NULL,
  party_id uuid,
  kind text NOT NULL CHECK (kind IN ('link', 'qr')),
  provider_ref text NOT NULL,
  url text,
  image_url text,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  partial_allowed boolean NOT NULL DEFAULT false,
  expires_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'partial', 'paid', 'expired', 'cancelled')),
  paid_paise bigint NOT NULL DEFAULT 0,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_requests_doc_idx ON payment_requests (org_id, document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_requests_ref_idx ON payment_requests (gateway_id, provider_ref);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS gateway_payments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  gateway_id uuid NOT NULL REFERENCES payment_gateways(id),
  provider_payment_id text NOT NULL,
  request_id uuid,
  payment_id uuid,
  document_id uuid,
  party_id uuid,
  amount_paise bigint NOT NULL,
  fee_paise bigint NOT NULL DEFAULT 0,
  tax_paise bigint NOT NULL DEFAULT 0,
  method text NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'processing', 'matched', 'unmatched')),
  -- a delivery claims the row while it works; a crashed one's claim lapses after a minute
  claimed_at bigint,
  refunded_paise bigint NOT NULL DEFAULT 0,
  settlement_id text,
  at bigint NOT NULL,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS gateway_payments_provider_idx ON gateway_payments (gateway_id, provider_payment_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS gateway_settlements (
  gateway_id uuid NOT NULL REFERENCES payment_gateways(id),
  provider_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  amount_paise bigint NOT NULL,
  fee_paise bigint NOT NULL DEFAULT 0,
  tax_paise bigint NOT NULL DEFAULT 0,
  utr text,
  status text NOT NULL,
  at bigint NOT NULL,
  -- what our own records add up to for this payout: payments settled in it, less their fees
  expected_paise bigint,
  matched boolean NOT NULL DEFAULT false,
  PRIMARY KEY (gateway_id, provider_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS gateway_refunds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  gateway_id uuid NOT NULL REFERENCES payment_gateways(id),
  gateway_payment_id uuid NOT NULL REFERENCES gateway_payments(id),
  credit_note_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'rejected', 'processing', 'processed', 'failed')),
  provider_refund_id text,
  payment_id uuid,
  error text,
  requested_by text NOT NULL,
  decided_by text,
  decided_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_gateways', 'payment_requests', 'gateway_payments', 'gateway_settlements', 'gateway_refunds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'')::uuid) WITH CHECK (org_id = current_setting(''app.org_id'')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_gateways, payment_requests, gateway_payments, gateway_settlements, gateway_refunds TO gst_app;
--> statement-breakpoint
-- A gateway's webhook names the gateway (the id is in the address we gave it), not an organisation: this view
-- (owned by the migration user, so it passes row-level security like the other operator views) finds the
-- organisation and the sealed webhook secret before anything else is read.
CREATE OR REPLACE VIEW gateway_webhook_keys AS SELECT id, org_id, business_id, provider, webhook_secret_enc, active FROM payment_gateways;
--> statement-breakpoint
GRANT SELECT ON gateway_webhook_keys TO gst_app;
