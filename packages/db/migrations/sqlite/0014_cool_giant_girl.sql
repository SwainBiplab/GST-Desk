CREATE TABLE `pos_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`document_id` text NOT NULL,
	`shift_id` text NOT NULL,
	`counter_id` text NOT NULL,
	`kind` text DEFAULT 'sale' NOT NULL,
	`tenders_json` text,
	`change_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`source_document_id` text,
	`returned_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_id`) REFERENCES `pos_counters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pos_bills_shift_id_idx` ON `pos_bills` (`shift_id`);--> statement-breakpoint
CREATE INDEX `pos_bills_document_id_idx` ON `pos_bills` (`document_id`);--> statement-breakpoint
CREATE INDEX `pos_bills_source_document_id_idx` ON `pos_bills` (`source_document_id`);--> statement-breakpoint
CREATE INDEX `pos_bills_business_id_idx` ON `pos_bills` (`business_id`);--> statement-breakpoint
CREATE INDEX `pos_bills_org_id_idx` ON `pos_bills` (`org_id`);--> statement-breakpoint
CREATE TABLE `pos_cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`shift_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`reason` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pos_cash_movements_shift_id_idx` ON `pos_cash_movements` (`shift_id`);--> statement-breakpoint
CREATE INDEX `pos_cash_movements_business_id_idx` ON `pos_cash_movements` (`business_id`);--> statement-breakpoint
CREATE INDEX `pos_cash_movements_org_id_idx` ON `pos_cash_movements` (`org_id`);--> statement-breakpoint
CREATE TABLE `pos_counters` (
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
	`series_key` text,
	`document_type` text DEFAULT 'tax_invoice' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pos_counters_business_id_idx` ON `pos_counters` (`business_id`);--> statement-breakpoint
CREATE INDEX `pos_counters_org_id_idx` ON `pos_counters` (`org_id`);--> statement-breakpoint
CREATE TABLE `pos_held_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`counter_id` text NOT NULL,
	`label` text,
	`party_id` text,
	`cart_json` text,
	`total_paise` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_id`) REFERENCES `pos_counters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pos_held_bills_counter_id_idx` ON `pos_held_bills` (`counter_id`);--> statement-breakpoint
CREATE INDEX `pos_held_bills_business_id_idx` ON `pos_held_bills` (`business_id`);--> statement-breakpoint
CREATE INDEX `pos_held_bills_org_id_idx` ON `pos_held_bills` (`org_id`);--> statement-breakpoint
CREATE TABLE `pos_shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`counter_id` text NOT NULL,
	`cashier` text,
	`opened_at` integer NOT NULL,
	`opening_float_paise` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`expected_cash_paise` integer,
	`counted_cash_paise` integer,
	`variance_paise` integer,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_id`) REFERENCES `pos_counters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pos_shifts_counter_id_status_idx` ON `pos_shifts` (`counter_id`,`status`);--> statement-breakpoint
CREATE INDEX `pos_shifts_business_id_idx` ON `pos_shifts` (`business_id`);--> statement-breakpoint
CREATE INDEX `pos_shifts_org_id_idx` ON `pos_shifts` (`org_id`);