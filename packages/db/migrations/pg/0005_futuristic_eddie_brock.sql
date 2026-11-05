CREATE TABLE "gst_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"period_fp" text NOT NULL,
	"field" text NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_filings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"return_type" text NOT NULL,
	"period_fp" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"exported_at" bigint,
	"schema_version" text,
	"arn" text,
	"filed_on" date,
	"due_override" date,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "gst_adjustments" ADD CONSTRAINT "gst_adjustments_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_adjustments" ADD CONSTRAINT "gst_adjustments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_filings" ADD CONSTRAINT "gst_filings_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_filings" ADD CONSTRAINT "gst_filings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gst_adjustments_business_id_period_fp_idx" ON "gst_adjustments" USING btree ("business_id","period_fp");--> statement-breakpoint
CREATE INDEX "gst_adjustments_business_id_idx" ON "gst_adjustments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gst_adjustments_org_id_idx" ON "gst_adjustments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gst_filings_business_id_return_type_period_fp_uq" ON "gst_filings" USING btree ("business_id","return_type","period_fp") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "gst_filings_business_id_idx" ON "gst_filings" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gst_filings_org_id_idx" ON "gst_filings" USING btree ("org_id");