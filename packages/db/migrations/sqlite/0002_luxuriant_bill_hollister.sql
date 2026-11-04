PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`payment_id` text,
	`document_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`kind` text DEFAULT 'payment' NOT NULL,
	`source_document_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_payment_allocations`("id", "org_id", "business_id", "version", "created_at", "updated_at", "deleted_at", "created_by", "updated_by", "payment_id", "document_id", "amount_paise", "kind", "source_document_id") SELECT "id", "org_id", "business_id", "version", "created_at", "updated_at", "deleted_at", "created_by", "updated_by", "payment_id", "document_id", "amount_paise", "kind", "source_document_id" FROM `payment_allocations`;--> statement-breakpoint
DROP TABLE `payment_allocations`;--> statement-breakpoint
ALTER TABLE `__new_payment_allocations` RENAME TO `payment_allocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_id_idx` ON `payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_document_id_idx` ON `payment_allocations` (`document_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_business_id_idx` ON `payment_allocations` (`business_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_org_id_idx` ON `payment_allocations` (`org_id`);--> statement-breakpoint
ALTER TABLE `business_accounts` ADD `holder_name` text;--> statement-breakpoint
ALTER TABLE `business_accounts` ADD `account_type` text;--> statement-breakpoint
ALTER TABLE `business_accounts` ADD `show_on_documents` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `cheque_date` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `tcs_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `voucher_id` text REFERENCES documents(id);