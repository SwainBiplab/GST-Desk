CREATE TABLE `gst_adjustments` (
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
	`field` text NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`cess_paise` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gst_adjustments_business_id_period_fp_idx` ON `gst_adjustments` (`business_id`,`period_fp`);--> statement-breakpoint
CREATE INDEX `gst_adjustments_business_id_idx` ON `gst_adjustments` (`business_id`);--> statement-breakpoint
CREATE INDEX `gst_adjustments_org_id_idx` ON `gst_adjustments` (`org_id`);--> statement-breakpoint
CREATE TABLE `gst_filings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`return_type` text NOT NULL,
	`period_fp` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`exported_at` integer,
	`schema_version` text,
	`arn` text,
	`filed_on` text,
	`due_override` text,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gst_filings_business_id_return_type_period_fp_uq` ON `gst_filings` (`business_id`,`return_type`,`period_fp`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `gst_filings_business_id_idx` ON `gst_filings` (`business_id`);--> statement-breakpoint
CREATE INDEX `gst_filings_org_id_idx` ON `gst_filings` (`org_id`);