ALTER TABLE "review_items" ADD COLUMN "snoozed_until" bigint;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "review_items_business_id_kind_dedupe_key_idx" ON "review_items" USING btree ("business_id","kind","dedupe_key");