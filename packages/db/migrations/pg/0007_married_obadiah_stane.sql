CREATE TABLE "einvoices" (
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
	"irn" text NOT NULL,
	"ack_no" text,
	"ack_date" text,
	"signed_invoice" text,
	"signed_qr" text,
	"status" text DEFAULT 'active' NOT NULL,
	"recovered" boolean DEFAULT false NOT NULL,
	"cancel_reason" text,
	"cancel_remarks" text,
	"cancelled_at" text
);
--> statement-breakpoint
CREATE TABLE "ewaybills" (
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
	"ewb_no" text NOT NULL,
	"generated_at" text NOT NULL,
	"valid_until" text,
	"status" text DEFAULT 'active' NOT NULL,
	"distance_km" integer,
	"trans_mode" text,
	"vehicle_no" text,
	"transporter_id" text,
	"from_place" text,
	"from_state" text,
	"from_pincode" text,
	"cancel_reason" text,
	"cancelled_at" text,
	"history_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "gsp_jobs" (
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
	"document_id" uuid,
	"ewaybill_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb,
	"args_json" jsonb,
	"doc_revision" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" bigint,
	"last_code" text,
	"last_message" text,
	"result_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "gsp_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"job_id" uuid,
	"document_id" uuid,
	"portal" text NOT NULL,
	"action" text NOT NULL,
	"request_json" jsonb,
	"response_json" jsonb,
	"ok" boolean DEFAULT false NOT NULL,
	"code" text,
	"message" text,
	"ms" integer
);
--> statement-breakpoint
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ewaybills" ADD CONSTRAINT "ewaybills_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ewaybills" ADD CONSTRAINT "ewaybills_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ewaybills" ADD CONSTRAINT "ewaybills_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_jobs" ADD CONSTRAINT "gsp_jobs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_jobs" ADD CONSTRAINT "gsp_jobs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_jobs" ADD CONSTRAINT "gsp_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_jobs" ADD CONSTRAINT "gsp_jobs_ewaybill_id_ewaybills_id_fk" FOREIGN KEY ("ewaybill_id") REFERENCES "public"."ewaybills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_log" ADD CONSTRAINT "gsp_log_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_log" ADD CONSTRAINT "gsp_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_log" ADD CONSTRAINT "gsp_log_job_id_gsp_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."gsp_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsp_log" ADD CONSTRAINT "gsp_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "einvoices_business_id_document_id_uq" ON "einvoices" USING btree ("business_id","document_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "einvoices_business_id_idx" ON "einvoices" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "einvoices_org_id_idx" ON "einvoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ewaybills_business_id_ewb_no_idx" ON "ewaybills" USING btree ("business_id","ewb_no");--> statement-breakpoint
CREATE INDEX "ewaybills_document_id_idx" ON "ewaybills" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ewaybills_business_id_idx" ON "ewaybills" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "ewaybills_org_id_idx" ON "ewaybills" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gsp_jobs_business_id_idempotency_key_uq" ON "gsp_jobs" USING btree ("business_id","idempotency_key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "gsp_jobs_business_id_status_idx" ON "gsp_jobs" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "gsp_jobs_business_id_idx" ON "gsp_jobs" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gsp_jobs_org_id_idx" ON "gsp_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gsp_log_business_id_document_id_idx" ON "gsp_log" USING btree ("business_id","document_id");--> statement-breakpoint
CREATE INDEX "gsp_log_job_id_idx" ON "gsp_log" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "gsp_log_business_id_idx" ON "gsp_log" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "gsp_log_org_id_idx" ON "gsp_log" USING btree ("org_id");