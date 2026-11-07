CREATE TABLE "godown_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"item_id" uuid NOT NULL,
	"godown_id" uuid NOT NULL,
	"min_stock_micros" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"item_id" uuid NOT NULL,
	"serial_no" text NOT NULL,
	"batch_id" uuid,
	"godown_id" uuid,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"last_movement_id" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"transfer_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"serials_json" jsonb,
	"qty_micros" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"number" text,
	"from_godown_id" uuid NOT NULL,
	"to_godown_id" uuid NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"date" date NOT NULL,
	"received_date" date,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "mrp_paise" bigint;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "purchase_rate_paise" bigint;--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "godown_id" uuid;--> statement-breakpoint
ALTER TABLE "godowns" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "godowns" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "godowns" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tracking_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "expiry_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "default_godown_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "serials_json" jsonb;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "cost_paise" bigint;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "cost_fixed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "godown_levels" ADD CONSTRAINT "godown_levels_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_levels" ADD CONSTRAINT "godown_levels_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_levels" ADD CONSTRAINT "godown_levels_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_levels" ADD CONSTRAINT "godown_levels_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_godown_id_godowns_id_fk" FOREIGN KEY ("from_godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_godown_id_godowns_id_fk" FOREIGN KEY ("to_godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "godown_levels_item_id_godown_id_uq" ON "godown_levels" USING btree ("item_id","godown_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "godown_levels_business_id_idx" ON "godown_levels" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "godown_levels_org_id_idx" ON "godown_levels" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serials_item_id_serial_no_uq" ON "serials" USING btree ("item_id","serial_no") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "serials_item_id_status_idx" ON "serials" USING btree ("item_id","status");--> statement-breakpoint
CREATE INDEX "serials_business_id_idx" ON "serials" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "serials_org_id_idx" ON "serials" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_business_id_idx" ON "stock_transfer_lines" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_org_id_idx" ON "stock_transfer_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stock_transfers_date_idx" ON "stock_transfers" USING btree ("date");--> statement-breakpoint
CREATE INDEX "stock_transfers_business_id_idx" ON "stock_transfers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_org_id_idx" ON "stock_transfers" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_default_godown_id_godowns_id_fk" FOREIGN KEY ("default_godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_voucher_id_journal_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."journal_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_item_id_batch_no_uq" ON "batches" USING btree ("item_id","batch_no") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_godown_id_idx" ON "stock_movements" USING btree ("godown_id");--> statement-breakpoint
CREATE INDEX "stock_movements_batch_id_idx" ON "stock_movements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_transfer_id_idx" ON "stock_movements" USING btree ("transfer_id");