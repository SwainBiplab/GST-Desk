CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"owner_table" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"actor" text NOT NULL,
	"device_id" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
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
	"batch_no" text NOT NULL,
	"mfg_date" date,
	"expiry_date" date
);
--> statement-breakpoint
CREATE TABLE "business_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"account_no" text,
	"ifsc" text,
	"upi_id" text,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"gstin" text,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"address" jsonb,
	"state_code" text NOT NULL,
	"pan" text,
	"scheme" text DEFAULT 'regular' NOT NULL,
	"fy_start_month" integer DEFAULT 4 NOT NULL,
	"preset" text,
	"settings_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "devices" (
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
	"platform" text,
	"last_seen_at" bigint
);
--> statement-breakpoint
CREATE TABLE "document_lines" (
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
	"line_no" integer NOT NULL,
	"item_id" uuid,
	"description" text,
	"hsn" text,
	"qty_micros" bigint DEFAULT 1000000 NOT NULL,
	"unit_id" uuid,
	"rate_paise" bigint DEFAULT 0 NOT NULL,
	"discount_mode" text DEFAULT 'none' NOT NULL,
	"discount_value" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_bp" integer DEFAULT 0 NOT NULL,
	"sgst_bp" integer DEFAULT 0 NOT NULL,
	"igst_bp" integer DEFAULT 0 NOT NULL,
	"utgst_bp" integer DEFAULT 0 NOT NULL,
	"cess_bp" integer DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"utgst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"serials_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"number" text,
	"series_id" uuid,
	"date" date NOT NULL,
	"due_date" date,
	"party_id" uuid,
	"party_name" text,
	"place_of_supply_state" text,
	"supply_type" text DEFAULT 'intra' NOT NULL,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"fx_rate_micros" bigint DEFAULT 1000000 NOT NULL,
	"total_taxable_paise" bigint DEFAULT 0 NOT NULL,
	"total_cgst_paise" bigint DEFAULT 0 NOT NULL,
	"total_sgst_paise" bigint DEFAULT 0 NOT NULL,
	"total_igst_paise" bigint DEFAULT 0 NOT NULL,
	"total_utgst_paise" bigint DEFAULT 0 NOT NULL,
	"total_cess_paise" bigint DEFAULT 0 NOT NULL,
	"tcs_paise" bigint DEFAULT 0 NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"terms" text,
	"template_id" uuid,
	"irn" text,
	"irn_ack_no" text,
	"irn_ack_date" text,
	"irn_signed_qr" text,
	"eway_bill_no" text,
	"eway_valid_until" bigint,
	"cancelled_at" bigint,
	"cancel_reason" text,
	"source_document_id" uuid,
	"metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "godowns" (
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
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hsn_master" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"rate_bp" integer DEFAULT 0 NOT NULL,
	"cess_bp" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_version" text
);
--> statement-breakpoint
CREATE TABLE "item_variants" (
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
	"name" text NOT NULL,
	"sku" text,
	"barcode" text,
	"sale_rate_paise" bigint,
	"attrs_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"kind" text DEFAULT 'goods' NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"barcode" text,
	"hsn" text,
	"unit_id" uuid,
	"sale_rate_paise" bigint DEFAULT 0 NOT NULL,
	"purchase_rate_paise" bigint DEFAULT 0 NOT NULL,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"cess_bp" integer DEFAULT 0 NOT NULL,
	"track_stock" boolean DEFAULT false NOT NULL,
	"min_stock_micros" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"parent_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"document_id" uuid,
	"payment_id" uuid,
	"account_id" uuid NOT NULL,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"date" date NOT NULL,
	"narration" text
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"user_id" uuid NOT NULL,
	"business_id" uuid,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"series_id" uuid NOT NULL,
	"device_id" uuid,
	"from_number" integer NOT NULL,
	"to_number" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"document_type" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"padding" integer DEFAULT 4 NOT NULL,
	"reset" text DEFAULT 'fy' NOT NULL,
	"fy" text,
	"next_number" integer DEFAULT 1 NOT NULL,
	"reserved_ranges_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"trade_name" text,
	"gstin" text,
	"pan" text,
	"phone" text,
	"email" text,
	"state_code" text,
	"addresses_json" jsonb,
	"contacts_json" jsonb,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"opening_balance_paise" bigint DEFAULT 0 NOT NULL,
	"is_sez" boolean DEFAULT false NOT NULL,
	"is_export" boolean DEFAULT false NOT NULL,
	"is_unregistered" boolean DEFAULT false NOT NULL,
	"is_composition" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"payment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"source_document_id" uuid
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"date" date NOT NULL,
	"mode" text NOT NULL,
	"account_id" uuid,
	"party_id" uuid,
	"amount_paise" bigint NOT NULL,
	"reference" text,
	"status" text DEFAULT 'cleared' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_master_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"effective_from" date NOT NULL,
	"source" text,
	"notes" text,
	"published_at" bigint,
	CONSTRAINT "rate_master_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_json" jsonb,
	"suggestion_json" jsonb,
	"diff_json" jsonb,
	"source" text,
	"model" text,
	"confidence" integer,
	"accepted_by" text,
	"accepted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"key" text NOT NULL,
	"value_json" jsonb,
	"scope" text DEFAULT 'business' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
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
	"variant_id" uuid,
	"godown_id" uuid,
	"batch_id" uuid,
	"kind" text NOT NULL,
	"qty_micros" bigint NOT NULL,
	"rate_paise" bigint,
	"document_id" uuid,
	"date" date NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"device_id" uuid,
	"cursor" text,
	"last_synced_at" bigint
);
--> statement-breakpoint
CREATE TABLE "templates" (
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
	"kind" text DEFAULT 'document' NOT NULL,
	"config_json" jsonb,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"locale" text DEFAULT 'en' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD CONSTRAINT "business_accounts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD CONSTRAINT "business_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godowns" ADD CONSTRAINT "godowns_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godowns" ADD CONSTRAINT "godowns_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_id_ledger_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_item_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."item_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_owner_table_owner_id_idx" ON "attachments" USING btree ("owner_table","owner_id");--> statement-breakpoint
CREATE INDEX "attachments_business_id_idx" ON "attachments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "attachments_org_id_idx" ON "attachments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_table_name_row_id_idx" ON "audit_log" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "audit_log_business_id_idx" ON "audit_log" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_id_idx" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "batches_item_id_idx" ON "batches" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "batches_business_id_idx" ON "batches" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "batches_org_id_idx" ON "batches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "business_accounts_business_id_idx" ON "business_accounts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "business_accounts_org_id_idx" ON "business_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "businesses_gstin_idx" ON "businesses" USING btree ("gstin");--> statement-breakpoint
CREATE INDEX "businesses_org_id_idx" ON "businesses" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "devices_business_id_idx" ON "devices" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "devices_org_id_idx" ON "devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "document_lines_document_id_idx" ON "document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_lines_item_id_idx" ON "document_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "document_lines_business_id_idx" ON "document_lines" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "document_lines_org_id_idx" ON "document_lines" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_business_id_type_number_uq" ON "documents" USING btree ("business_id","type","number") WHERE status <> 'draft' AND number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_business_id_type_date_idx" ON "documents" USING btree ("business_id","type","date");--> statement-breakpoint
CREATE INDEX "documents_party_id_idx" ON "documents" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "documents_business_id_idx" ON "documents" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "documents_org_id_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "godowns_business_id_idx" ON "godowns" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "godowns_org_id_idx" ON "godowns" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hsn_master_code_effective_from_uq" ON "hsn_master" USING btree ("code","effective_from");--> statement-breakpoint
CREATE INDEX "item_variants_item_id_idx" ON "item_variants" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_variants_business_id_idx" ON "item_variants" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "item_variants_org_id_idx" ON "item_variants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "items_business_id_sku_idx" ON "items" USING btree ("business_id","sku");--> statement-breakpoint
CREATE INDEX "items_business_id_barcode_idx" ON "items" USING btree ("business_id","barcode");--> statement-breakpoint
CREATE INDEX "items_business_id_idx" ON "items" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "items_org_id_idx" ON "items" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_business_id_code_uq" ON "ledger_accounts" USING btree ("business_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "ledger_accounts_business_id_idx" ON "ledger_accounts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_org_id_idx" ON "ledger_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_date_idx" ON "ledger_entries" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "ledger_entries_document_id_idx" ON "ledger_entries" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_business_id_idx" ON "ledger_entries" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_id_idx" ON "ledger_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_org_id_idx" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "number_reservations_series_id_idx" ON "number_reservations" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "number_reservations_business_id_idx" ON "number_reservations" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "number_reservations_org_id_idx" ON "number_reservations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "number_series_business_id_document_type_prefix_fy_idx" ON "number_series" USING btree ("business_id","document_type","prefix","fy");--> statement-breakpoint
CREATE INDEX "number_series_business_id_idx" ON "number_series" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "number_series_org_id_idx" ON "number_series" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "parties_business_id_gstin_idx" ON "parties" USING btree ("business_id","gstin");--> statement-breakpoint
CREATE INDEX "parties_business_id_name_idx" ON "parties" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "parties_business_id_idx" ON "parties" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "parties_org_id_idx" ON "parties" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_document_id_idx" ON "payment_allocations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_business_id_idx" ON "payment_allocations" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_org_id_idx" ON "payment_allocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payments_party_id_idx" ON "payments" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "payments_business_id_idx" ON "payments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "payments_org_id_idx" ON "payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "review_items_business_id_status_idx" ON "review_items" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "review_items_business_id_idx" ON "review_items" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "review_items_org_id_idx" ON "review_items" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_business_id_scope_key_uq" ON "settings" USING btree ("business_id","scope","key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "settings_business_id_idx" ON "settings" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "settings_org_id_idx" ON "settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_movements_item_id_date_idx" ON "stock_movements" USING btree ("item_id","date");--> statement-breakpoint
CREATE INDEX "stock_movements_document_id_idx" ON "stock_movements" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "stock_movements_business_id_idx" ON "stock_movements" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "stock_movements_org_id_idx" ON "stock_movements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sync_state_org_id_idx" ON "sync_state" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "templates_business_id_idx" ON "templates" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "templates_org_id_idx" ON "templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "units_business_id_code_uq" ON "units" USING btree ("business_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "units_business_id_idx" ON "units" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "units_org_id_idx" ON "units" USING btree ("org_id");