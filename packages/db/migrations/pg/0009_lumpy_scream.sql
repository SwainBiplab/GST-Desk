ALTER TABLE "devices" ADD COLUMN "kind" text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_issued_at" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "prev_token_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "prev_valid_until" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_at" bigint;--> statement-breakpoint
CREATE INDEX "devices_token_hash_idx" ON "devices" USING btree ("token_hash");