-- Team (prompt 42). An organisation's own roles (grants over the shared permission matrix), which member
-- or pending invitation holds one, and its approval policy. better-auth's `auth_member.role` keeps a
-- built-in role; a custom role is recorded here and overrides it (the built-in one is then `viewer`, so a
-- lost row fails closed).
CREATE TABLE IF NOT EXISTS org_roles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  grants jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS org_roles_name_idx ON org_roles (org_id, lower(name)) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS member_roles (
  member_id text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  role_id uuid NOT NULL REFERENCES org_roles(id),
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invitation_roles (
  invitation_id text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organisations(id),
  role_id uuid NOT NULL REFERENCES org_roles(id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS org_policies (
  org_id uuid PRIMARY KEY REFERENCES organisations(id),
  approvals boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL,
  updated_by text
);
--> statement-breakpoint
ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_roles USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE member_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_roles USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE invitation_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitation_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitation_roles USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE org_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_policies USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_roles, member_roles, invitation_roles, org_policies TO gst_app;
