-- Push notifications (prompt 43): the phones a person signed in on. A token is a user's, not an
-- organisation's, so there is no row-level security here; the API reads them by user id only.
CREATE TABLE IF NOT EXISTS push_tokens (
  token text PRIMARY KEY,
  user_id text NOT NULL,
  device_id text,
  platform text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON push_tokens TO gst_app;
