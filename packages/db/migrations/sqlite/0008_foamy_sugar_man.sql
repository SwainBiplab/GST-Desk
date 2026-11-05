CREATE TABLE `tax_challans` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`kind` text NOT NULL,
	`fy` text NOT NULL,
	`quarter` text NOT NULL,
	`section` text,
	`bsr_code` text NOT NULL,
	`deposit_date` text NOT NULL,
	`serial` text NOT NULL,
	`tax_paise` integer DEFAULT 0 NOT NULL,
	`interest_paise` integer DEFAULT 0 NOT NULL,
	`fee_paise` integer DEFAULT 0 NOT NULL,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tax_challans_business_id_fy_quarter_idx` ON `tax_challans` (`business_id`,`fy`,`quarter`);--> statement-breakpoint
CREATE INDEX `tax_challans_business_id_idx` ON `tax_challans` (`business_id`);--> statement-breakpoint
CREATE INDEX `tax_challans_org_id_idx` ON `tax_challans` (`org_id`);--> statement-breakpoint
CREATE TABLE `tax_deductions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`kind` text NOT NULL,
	`party_id` text NOT NULL,
	`document_id` text,
	`section` text NOT NULL,
	`nature` text,
	`date` text NOT NULL,
	`fy` text NOT NULL,
	`quarter` text NOT NULL,
	`base_paise` integer DEFAULT 0 NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`tax_paise` integer DEFAULT 0 NOT NULL,
	`no_pan` integer DEFAULT false NOT NULL,
	`lower_cert` integer DEFAULT false NOT NULL,
	`challan_id` text,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challan_id`) REFERENCES `tax_challans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tax_deductions_business_id_fy_quarter_kind_idx` ON `tax_deductions` (`business_id`,`fy`,`quarter`,`kind`);--> statement-breakpoint
CREATE INDEX `tax_deductions_business_id_party_id_fy_idx` ON `tax_deductions` (`business_id`,`party_id`,`fy`);--> statement-breakpoint
CREATE INDEX `tax_deductions_document_id_idx` ON `tax_deductions` (`document_id`);--> statement-breakpoint
CREATE INDEX `tax_deductions_business_id_idx` ON `tax_deductions` (`business_id`);--> statement-breakpoint
CREATE INDEX `tax_deductions_org_id_idx` ON `tax_deductions` (`org_id`);--> statement-breakpoint
CREATE TABLE `tds_receivable` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`party_id` text NOT NULL,
	`fy` text NOT NULL,
	`quarter` text NOT NULL,
	`section` text NOT NULL,
	`date` text NOT NULL,
	`gross_paise` integer DEFAULT 0 NOT NULL,
	`tds_paise` integer DEFAULT 0 NOT NULL,
	`certificate_no` text,
	`certificate_date` text,
	`status` text DEFAULT 'expected' NOT NULL,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tds_receivable_business_id_fy_quarter_idx` ON `tds_receivable` (`business_id`,`fy`,`quarter`);--> statement-breakpoint
CREATE INDEX `tds_receivable_business_id_party_id_idx` ON `tds_receivable` (`business_id`,`party_id`);--> statement-breakpoint
CREATE INDEX `tds_receivable_business_id_idx` ON `tds_receivable` (`business_id`);--> statement-breakpoint
CREATE INDEX `tds_receivable_org_id_idx` ON `tds_receivable` (`org_id`);--> statement-breakpoint
ALTER TABLE `parties` ADD `deductee_type` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `tds_section` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `tds_category` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `tds_kind` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `tcs_nature` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `lower_cert_no` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `lower_cert_rate_bp` integer;--> statement-breakpoint
ALTER TABLE `parties` ADD `lower_cert_from` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `lower_cert_to` text;--> statement-breakpoint
ALTER TABLE `parties` ADD `lower_cert_limit_paise` integer;