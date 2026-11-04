ALTER TABLE "payment_allocations" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD COLUMN "holder_name" text;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD COLUMN "account_type" text;--> statement-breakpoint
ALTER TABLE "business_accounts" ADD COLUMN "show_on_documents" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cheque_date" date;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tcs_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_id_documents_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;