CREATE TABLE `gst_issue_acks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`period_fp` text NOT NULL,
	`issue_key` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gst_issue_acks_business_id_period_fp_issue_key_uq` ON `gst_issue_acks` (`business_id`,`period_fp`,`issue_key`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `gst_issue_acks_business_id_idx` ON `gst_issue_acks` (`business_id`);--> statement-breakpoint
CREATE INDEX `gst_issue_acks_org_id_idx` ON `gst_issue_acks` (`org_id`);--> statement-breakpoint
CREATE TABLE `gstr2b_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`period_fp` text NOT NULL,
	`side` text NOT NULL,
	`ref_key` text NOT NULL,
	`decision` text NOT NULL,
	`linked_document_id` text,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gstr2b_decisions_business_id_period_fp_idx` ON `gstr2b_decisions` (`business_id`,`period_fp`);--> statement-breakpoint
CREATE INDEX `gstr2b_decisions_business_id_idx` ON `gstr2b_decisions` (`business_id`);--> statement-breakpoint
CREATE INDEX `gstr2b_decisions_org_id_idx` ON `gstr2b_decisions` (`org_id`);--> statement-breakpoint
CREATE TABLE `gstr2b_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`import_id` text NOT NULL,
	`period_fp` text NOT NULL,
	`supplier_gstin` text NOT NULL,
	`supplier_name` text,
	`doc_type` text NOT NULL,
	`number` text NOT NULL,
	`number_key` text NOT NULL,
	`date` text NOT NULL,
	`taxable_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`cess_paise` integer DEFAULT 0 NOT NULL,
	`itc_available` text,
	`reason` text,
	`supplier_period` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `gstr2b_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gstr2b_entries_business_id_period_fp_idx` ON `gstr2b_entries` (`business_id`,`period_fp`);--> statement-breakpoint
CREATE INDEX `gstr2b_entries_business_id_supplier_gstin_number_key_idx` ON `gstr2b_entries` (`business_id`,`supplier_gstin`,`number_key`);--> statement-breakpoint
CREATE INDEX `gstr2b_entries_business_id_idx` ON `gstr2b_entries` (`business_id`);--> statement-breakpoint
CREATE INDEX `gstr2b_entries_org_id_idx` ON `gstr2b_entries` (`org_id`);--> statement-breakpoint
CREATE TABLE `gstr2b_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`period_fp` text NOT NULL,
	`gstin` text NOT NULL,
	`source` text NOT NULL,
	`parser_version` text,
	`file_hash` text,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`problems_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gstr2b_imports_business_id_period_fp_idx` ON `gstr2b_imports` (`business_id`,`period_fp`);--> statement-breakpoint
CREATE INDEX `gstr2b_imports_business_id_idx` ON `gstr2b_imports` (`business_id`);--> statement-breakpoint
CREATE INDEX `gstr2b_imports_org_id_idx` ON `gstr2b_imports` (`org_id`);--> statement-breakpoint
ALTER TABLE `gst_adjustments` ADD `source` text;