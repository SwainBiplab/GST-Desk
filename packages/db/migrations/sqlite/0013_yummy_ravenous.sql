CREATE TABLE `godown_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`item_id` text NOT NULL,
	`godown_id` text NOT NULL,
	`min_stock_micros` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`godown_id`) REFERENCES `godowns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `godown_levels_item_id_godown_id_uq` ON `godown_levels` (`item_id`,`godown_id`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `godown_levels_business_id_idx` ON `godown_levels` (`business_id`);--> statement-breakpoint
CREATE INDEX `godown_levels_org_id_idx` ON `godown_levels` (`org_id`);--> statement-breakpoint
CREATE TABLE `serials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`item_id` text NOT NULL,
	`serial_no` text NOT NULL,
	`batch_id` text,
	`godown_id` text,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`last_movement_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`godown_id`) REFERENCES `godowns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `serials_item_id_serial_no_uq` ON `serials` (`item_id`,`serial_no`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `serials_item_id_status_idx` ON `serials` (`item_id`,`status`);--> statement-breakpoint
CREATE INDEX `serials_business_id_idx` ON `serials` (`business_id`);--> statement-breakpoint
CREATE INDEX `serials_org_id_idx` ON `serials` (`org_id`);--> statement-breakpoint
CREATE TABLE `stock_transfer_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`transfer_id` text NOT NULL,
	`item_id` text NOT NULL,
	`batch_id` text,
	`serials_json` text,
	`qty_micros` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_transfer_lines_transfer_id_idx` ON `stock_transfer_lines` (`transfer_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_lines_business_id_idx` ON `stock_transfer_lines` (`business_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_lines_org_id_idx` ON `stock_transfer_lines` (`org_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`number` text,
	`from_godown_id` text NOT NULL,
	`to_godown_id` text NOT NULL,
	`status` text DEFAULT 'dispatched' NOT NULL,
	`date` text NOT NULL,
	`received_date` text,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_godown_id`) REFERENCES `godowns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_godown_id`) REFERENCES `godowns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_transfers_status_idx` ON `stock_transfers` (`status`);--> statement-breakpoint
CREATE INDEX `stock_transfers_date_idx` ON `stock_transfers` (`date`);--> statement-breakpoint
CREATE INDEX `stock_transfers_business_id_idx` ON `stock_transfers` (`business_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_org_id_idx` ON `stock_transfers` (`org_id`);--> statement-breakpoint
ALTER TABLE `batches` ADD `mrp_paise` integer;--> statement-breakpoint
ALTER TABLE `batches` ADD `purchase_rate_paise` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `batches_item_id_batch_no_uq` ON `batches` (`item_id`,`batch_no`) WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE `document_lines` ADD `godown_id` text REFERENCES godowns(id);--> statement-breakpoint
ALTER TABLE `godowns` ADD `code` text;--> statement-breakpoint
ALTER TABLE `godowns` ADD `address` text;--> statement-breakpoint
ALTER TABLE `godowns` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `tracking_mode` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `expiry_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `default_godown_id` text REFERENCES godowns(id);--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `serials_json` text;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `cost_paise` integer;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `cost_fixed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `transfer_id` text REFERENCES stock_transfers(id);--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `voucher_id` text REFERENCES journal_vouchers(id);--> statement-breakpoint
CREATE INDEX `stock_movements_godown_id_idx` ON `stock_movements` (`godown_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_batch_id_idx` ON `stock_movements` (`batch_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_transfer_id_idx` ON `stock_movements` (`transfer_id`);