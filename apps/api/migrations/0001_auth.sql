-- better-auth's tables (see src/auth/schema.ts). Timestamps are timestamptz, ids are text uuids made by the app.
CREATE TABLE IF NOT EXISTS auth_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  phone_number text UNIQUE,
  phone_number_verified boolean,
  two_factor_enabled boolean DEFAULT false,
  locale text DEFAULT 'en'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  active_organization_id text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_account_user_idx ON auth_account (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification (identifier);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_two_factor_user_idx ON auth_two_factor (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES auth_organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_member_org_idx ON auth_member (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_member_user_idx ON auth_member (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES auth_organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_invitation_org_idx ON auth_invitation (organization_id);
