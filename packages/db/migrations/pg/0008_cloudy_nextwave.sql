CREATE TABLE "tax_challans" (
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
	"fy" text NOT NULL,
	"quarter" text NOT NULL,
	"section" text,
	"bsr_code" text NOT NULL,
	"deposit_date" date NOT NULL,
	"serial" text NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"interest_paise" bigint DEFAULT 0 NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "tax_deductions" (
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
	"party_id" uuid NOT NULL,
	"document_id" uuid,
	"section" text NOT NULL,
	"nature" text,
	"date" date NOT NULL,
	"fy" text NOT NULL,
	"quarter" text NOT NULL,
	"base_paise" bigint DEFAULT 0 NOT NULL,
	"rate_bp" integer DEFAULT 0 NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"no_pan" boolean DEFAULT false NOT NULL,
	"lower_cert" boolean DEFAULT false NOT NULL,
	"challan_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "tds_receivable" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"party_id" uuid NOT NULL,
	"fy" text NOT NULL,
	"quarter" text NOT NULL,
	"section" text NOT NULL,
	"date" date NOT NULL,
	"gross_paise" bigint DEFAULT 0 NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"certificate_no" text,
	"certificate_date" date,
	"status" text DEFAULT 'expected' NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "deductee_type" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tds_section" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tds_category" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tds_kind" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tcs_nature" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "lower_cert_no" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "lower_cert_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "lower_cert_from" date;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "lower_cert_to" date;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "lower_cert_limit_paise" bigint;--> statement-breakpoint
ALTER TABLE "tax_challans" ADD CONSTRAINT "tax_challans_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_challans" ADD CONSTRAINT "tax_challans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_deductions" ADD CONSTRAINT "tax_deductions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_deductions" ADD CONSTRAINT "tax_deductions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_deductions" ADD CONSTRAINT "tax_deductions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_deductions" ADD CONSTRAINT "tax_deductions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_deductions" ADD CONSTRAINT "tax_deductions_challan_id_tax_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."tax_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_receivable" ADD CONSTRAINT "tds_receivable_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_receivable" ADD CONSTRAINT "tds_receivable_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_receivable" ADD CONSTRAINT "tds_receivable_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_challans_business_id_fy_quarter_idx" ON "tax_challans" USING btree ("business_id","fy","quarter");--> statement-breakpoint
CREATE INDEX "tax_challans_business_id_idx" ON "tax_challans" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "tax_challans_org_id_idx" ON "tax_challans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tax_deductions_business_id_fy_quarter_kind_idx" ON "tax_deductions" USING btree ("business_id","fy","quarter","kind");--> statement-breakpoint
CREATE INDEX "tax_deductions_business_id_party_id_fy_idx" ON "tax_deductions" USING btree ("business_id","party_id","fy");--> statement-breakpoint
CREATE INDEX "tax_deductions_document_id_idx" ON "tax_deductions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "tax_deductions_business_id_idx" ON "tax_deductions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "tax_deductions_org_id_idx" ON "tax_deductions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tds_receivable_business_id_fy_quarter_idx" ON "tds_receivable" USING btree ("business_id","fy","quarter");--> statement-breakpoint
CREATE INDEX "tds_receivable_business_id_party_id_idx" ON "tds_receivable" USING btree ("business_id","party_id");--> statement-breakpoint
CREATE INDEX "tds_receivable_business_id_idx" ON "tds_receivable" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "tds_receivable_org_id_idx" ON "tds_receivable" USING btree ("org_id");