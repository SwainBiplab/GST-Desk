CREATE TABLE "gst_issue_acks" (
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
	"issue_key" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gstr2b_decisions" (
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
	"side" text NOT NULL,
	"ref_key" text NOT NULL,
	"decision" text NOT NULL,
	"linked_document_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "gstr2b_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"import_id" uuid NOT NULL,
	"period_fp" text NOT NULL,
	"supplier_gstin" text NOT NULL,
	"supplier_name" text,
	"doc_type" text NOT NULL,
	"number" text NOT NULL,
	"number_key" text NOT NULL,
	"date" date NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"itc_available" text,
	"reason" text,
	"supplier_period" text
);
--> statement-breakpoint
CREATE TABLE "gstr2b_imports" (
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
	"gstin" text NOT NULL,
	"source" text NOT NULL,
	"parser_version" text,
	"file_hash" text,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"problems_json" jsonb
);
--> statement-breakpoint
ALTER TABLE "gst_adjustments" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "gst_issue_acks" ADD CONSTRAINT "gst_issue_acks_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_issue_acks" ADD CONSTRAINT "gst_issue_acks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_decisions" ADD CONSTRAINT "gstr2b_decisions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_decisions" ADD CONSTRAINT "gstr2b_decisions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_decisions" ADD CONSTRAINT "gstr2b_decisions_linked_document_id_documents_id_fk" FOREIGN KEY ("linked_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_entries" ADD CONSTRAINT "gstr2b_entries_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_entries" ADD CONSTRAINT "gstr2b_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_entries" ADD CONSTRAINT "gstr2b_entries_import_id_gstr2b_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."gstr2b_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_imports" ADD CONSTRAINT "gstr2b_imports_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_imports" ADD CONSTRAINT "gstr2b_imports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gst_issue_acks_business_id_period_fp_issue_key_uq" ON "gst_issue_acks" USING btree ("business_id","period_fp","issue_key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "gst_issue_acks_business_id_idx" ON "gst_issue_acks" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gst_issue_acks_org_id_idx" ON "gst_issue_acks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gstr2b_decisions_business_id_period_fp_idx" ON "gstr2b_decisions" USING btree ("business_id","period_fp");--> statement-breakpoint
CREATE INDEX "gstr2b_decisions_business_id_idx" ON "gstr2b_decisions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gstr2b_decisions_org_id_idx" ON "gstr2b_decisions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gstr2b_entries_business_id_period_fp_idx" ON "gstr2b_entries" USING btree ("business_id","period_fp");--> statement-breakpoint
CREATE INDEX "gstr2b_entries_business_id_supplier_gstin_number_key_idx" ON "gstr2b_entries" USING btree ("business_id","supplier_gstin","number_key");--> statement-breakpoint
CREATE INDEX "gstr2b_entries_business_id_idx" ON "gstr2b_entries" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gstr2b_entries_org_id_idx" ON "gstr2b_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gstr2b_imports_business_id_period_fp_idx" ON "gstr2b_imports" USING btree ("business_id","period_fp");--> statement-breakpoint
CREATE INDEX "gstr2b_imports_business_id_idx" ON "gstr2b_imports" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gstr2b_imports_org_id_idx" ON "gstr2b_imports" USING btree ("org_id");