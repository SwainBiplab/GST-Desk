CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"fy_start" date NOT NULL,
	"fy_end" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closing_voucher_id" uuid,
	"closed_at" bigint,
	"closed_by" text,
	"reopened_at" bigint,
	"reopened_by" text,
	"reopen_reason" text
);
--> statement-breakpoint
CREATE TABLE "journal_vouchers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"created_by" text,
	"updated_by" text,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"kind" text DEFAULT 'journal' NOT NULL,
	"narration" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"reversed_by" uuid,
	"reverses" uuid,
	"recurring_id" uuid,
	"total_paise" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_journals" (
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
	"every" text DEFAULT 'monthly' NOT NULL,
	"day" integer DEFAULT 1 NOT NULL,
	"next_date" date NOT NULL,
	"end_date" date,
	"lines_json" jsonb,
	"narration" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_posted_date" date
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "sub_group" text;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "tally_name" text;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "business_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_closing_voucher_id_journal_vouchers_id_fk" FOREIGN KEY ("closing_voucher_id") REFERENCES "public"."journal_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_reversed_by_journal_vouchers_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."journal_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_reverses_journal_vouchers_id_fk" FOREIGN KEY ("reverses") REFERENCES "public"."journal_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_recurring_id_recurring_journals_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_business_id_fy_start_uq" ON "fiscal_years" USING btree ("business_id","fy_start") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "fiscal_years_business_id_idx" ON "fiscal_years" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "fiscal_years_org_id_idx" ON "fiscal_years" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_vouchers_business_id_number_uq" ON "journal_vouchers" USING btree ("business_id","number") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "journal_vouchers_business_id_date_idx" ON "journal_vouchers" USING btree ("business_id","date");--> statement-breakpoint
CREATE INDEX "journal_vouchers_business_id_idx" ON "journal_vouchers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "journal_vouchers_org_id_idx" ON "journal_vouchers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "recurring_journals_business_id_next_date_idx" ON "recurring_journals" USING btree ("business_id","next_date");--> statement-breakpoint
CREATE INDEX "recurring_journals_business_id_idx" ON "recurring_journals" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "recurring_journals_org_id_idx" ON "recurring_journals" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_account_id_business_accounts_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_voucher_id_journal_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."journal_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_voucher_id_idx" ON "ledger_entries" USING btree ("voucher_id");