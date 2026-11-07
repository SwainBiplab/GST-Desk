-- CA and client portals (prompt 47). An owner shares one business, read-only, with an accountant for a financial
-- year or a date range (`business_shares`); a customer gets a public link to one invoice or one statement
-- (`portal_links`, the token kept only as a hash); and an accountant asks for an export pack built as a job
-- (`export_packs`). Everything is row-level secured by organisation; the two views below are the lookups that
-- happen before an organisation is known (which business is shared with this account, which link a token names).
CREATE TABLE IF NOT EXISTS business_shares (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  -- the address the invitation is for (a phone invitation is addressed to the e-mail a phone sign-in gets)
  grantee_email text NOT NULL,
  grantee_user_id text,
  -- what the grantee may read: ISO dates, inclusive
  scope_from text NOT NULL,
  scope_to text NOT NULL,
  -- {"read": true, "gst": true, "export": false, "comment": true}
  perms jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'declined')),
  -- when the access itself ends (null: until revoked)
  expires_at bigint,
  note text,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  accepted_at bigint,
  revoked_at bigint,
  revoked_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS business_shares_live_idx ON business_shares (org_id, business_id, lower(grantee_email))
  WHERE status IN ('pending', 'active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_shares_grantee_idx ON business_shares (grantee_user_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_shares_email_idx ON business_shares (lower(grantee_email)) WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS portal_settings (
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  -- how long a new link lives, in days
  link_days integer NOT NULL DEFAULT 90 CHECK (link_days BETWEEN 1 AND 730),
  statements boolean NOT NULL DEFAULT true,
  -- whether a customer may ask a question or dispute from the page
  questions boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (org_id, business_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS portal_links (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('document', 'statement')),
  document_id uuid,
  party_id uuid,
  -- sha-256 of the 128-bit token; the token itself is shown once (and kept sealed under the platform key, when
  -- there is one, so the owner can copy the link again)
  token_hash text NOT NULL UNIQUE,
  token_enc text,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  views integer NOT NULL DEFAULT 0,
  last_viewed_at bigint,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK ((kind = 'document' AND document_id IS NOT NULL) OR (kind = 'statement' AND party_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS portal_links_document_idx ON portal_links (org_id, document_id) WHERE document_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS portal_links_party_idx ON portal_links (org_id, party_id) WHERE party_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS export_packs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  business_id uuid NOT NULL,
  share_id uuid,
  from_date text NOT NULL,
  to_date text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  storage_key text,
  size_bytes bigint,
  manifest_json jsonb,
  error text,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  finished_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS export_packs_business_idx ON export_packs (org_id, business_id, created_at DESC);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_shares', 'portal_settings', 'portal_links', 'export_packs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'')::uuid) WITH CHECK (org_id = current_setting(''app.org_id'')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON business_shares, portal_settings, portal_links, export_packs TO gst_app;
--> statement-breakpoint
-- Which businesses are shared with an account, read before any organisation is known (as the board does for
-- memberships). Owned by the migration user, so the tenant policy does not apply; it carries no books.
CREATE OR REPLACE VIEW business_share_grants AS
  SELECT id, org_id, business_id, grantee_user_id, lower(grantee_email) AS grantee_email, status, expires_at,
         scope_from, scope_to, perms, note, created_at, accepted_at
  FROM business_shares WHERE status IN ('pending', 'active');
--> statement-breakpoint
GRANT SELECT ON business_share_grants TO gst_app;
--> statement-breakpoint
-- Which organisation a public token belongs to: only the hash is matched, and only the organisation comes back.
CREATE OR REPLACE VIEW portal_link_lookup AS SELECT token_hash, org_id FROM portal_links;
--> statement-breakpoint
GRANT SELECT ON portal_link_lookup TO gst_app;
