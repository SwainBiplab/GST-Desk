CREATE TABLE `fiscal_years` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`fy_start` text NOT NULL,
	`fy_end` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closing_voucher_id` text,
	`closed_at` integer,
	`closed_by` text,
	`reopened_at` integer,
	`reopened_by` text,
	`reopen_reason` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closing_voucher_id`) REFERENCES `journal_vouchers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_years_business_id_fy_start_uq` ON `fiscal_years` (`business_id`,`fy_start`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `fiscal_years_business_id_idx` ON `fiscal_years` (`business_id`);--> statement-breakpoint
CREATE INDEX `fiscal_years_org_id_idx` ON `fiscal_years` (`org_id`);--> statement-breakpoint
CREATE TABLE `journal_vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`number` text NOT NULL,
	`date` text NOT NULL,
	`kind` text DEFAULT 'journal' NOT NULL,
	`narration` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`reversed_by` text,
	`reverses` text,
	`recurring_id` text,
	`total_paise` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reversed_by`) REFERENCES `journal_vouchers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverses`) REFERENCES `journal_vouchers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_journals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_vouchers_business_id_number_uq` ON `journal_vouchers` (`business_id`,`number`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `journal_vouchers_business_id_date_idx` ON `journal_vouchers` (`business_id`,`date`);--> statement-breakpoint
CREATE INDEX `journal_vouchers_business_id_idx` ON `journal_vouchers` (`business_id`);--> statement-breakpoint
CREATE INDEX `journal_vouchers_org_id_idx` ON `journal_vouchers` (`org_id`);--> statement-breakpoint
CREATE TABLE `recurring_journals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`name` text NOT NULL,
	`every` text DEFAULT 'monthly' NOT NULL,
	`day` integer DEFAULT 1 NOT NULL,
	`next_date` text NOT NULL,
	`end_date` text,
	`lines_json` text,
	`narration` text,
	`active` integer DEFAULT true NOT NULL,
	`last_posted_date` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_journals_business_id_next_date_idx` ON `recurring_journals` (`business_id`,`next_date`);--> statement-breakpoint
CREATE INDEX `recurring_journals_business_id_idx` ON `recurring_journals` (`business_id`);--> statement-breakpoint
CREATE INDEX `recurring_journals_org_id_idx` ON `recurring_journals` (`org_id`);--> statement-breakpoint
ALTER TABLE `ledger_accounts` ADD `sub_group` text;--> statement-breakpoint
ALTER TABLE `ledger_accounts` ADD `tally_name` text;--> statement-breakpoint
ALTER TABLE `ledger_accounts` ADD `business_account_id` text REFERENCES business_accounts(id);--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD `voucher_id` text REFERENCES journal_vouchers(id);--> statement-breakpoint
CREATE INDEX `ledger_entries_voucher_id_idx` ON `ledger_entries` (`voucher_id`);