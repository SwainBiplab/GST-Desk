CREATE TABLE "pos_bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"document_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"counter_id" uuid NOT NULL,
	"kind" text DEFAULT 'sale' NOT NULL,
	"tenders_json" jsonb,
	"change_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"source_document_id" uuid,
	"returned_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "pos_cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"shift_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "pos_counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"name" text NOT NULL,
	"series_key" text,
	"document_type" text DEFAULT 'tax_invoice' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_held_bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"counter_id" uuid NOT NULL,
	"label" text,
	"party_id" uuid,
	"cart_json" jsonb,
	"total_paise" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"counter_id" uuid NOT NULL,
	"cashier" text,
	"opened_at" bigint NOT NULL,
	"opening_float_paise" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" bigint,
	"expected_cash_paise" bigint,
	"counted_cash_paise" bigint,
	"variance_paise" bigint,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_counter_id_pos_counters_id_fk" FOREIGN KEY ("counter_id") REFERENCES "public"."pos_counters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_counters" ADD CONSTRAINT "pos_counters_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_counters" ADD CONSTRAINT "pos_counters_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_bills" ADD CONSTRAINT "pos_held_bills_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_bills" ADD CONSTRAINT "pos_held_bills_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_bills" ADD CONSTRAINT "pos_held_bills_counter_id_pos_counters_id_fk" FOREIGN KEY ("counter_id") REFERENCES "public"."pos_counters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_bills" ADD CONSTRAINT "pos_held_bills_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_counter_id_pos_counters_id_fk" FOREIGN KEY ("counter_id") REFERENCES "public"."pos_counters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_bills_shift_id_idx" ON "pos_bills" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_bills_document_id_idx" ON "pos_bills" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "pos_bills_source_document_id_idx" ON "pos_bills" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "pos_bills_business_id_idx" ON "pos_bills" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "pos_bills_org_id_idx" ON "pos_bills" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pos_cash_movements_shift_id_idx" ON "pos_cash_movements" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_cash_movements_business_id_idx" ON "pos_cash_movements" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "pos_cash_movements_org_id_idx" ON "pos_cash_movements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pos_counters_business_id_idx" ON "pos_counters" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "pos_counters_org_id_idx" ON "pos_counters" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pos_held_bills_counter_id_idx" ON "pos_held_bills" USING btree ("counter_id");--> statement-breakpoint
CREATE INDEX "pos_held_bills_business_id_idx" ON "pos_held_bills" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "pos_held_bills_org_id_idx" ON "pos_held_bills" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pos_shifts_counter_id_status_idx" ON "pos_shifts" USING btree ("counter_id","status");--> statement-breakpoint
CREATE INDEX "pos_shifts_business_id_idx" ON "pos_shifts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "pos_shifts_org_id_idx" ON "pos_shifts" USING btree ("org_id");