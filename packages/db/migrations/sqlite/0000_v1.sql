CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`feature` text NOT NULL,
	`capability` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_calls_business_id_feature_idx` ON `ai_calls` (`business_id`,`feature`);--> statement-breakpoint
CREATE INDEX `ai_calls_business_id_idx` ON `ai_calls` (`business_id`);--> statement-breakpoint
CREATE INDEX `ai_calls_org_id_idx` ON `ai_calls` (`org_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`owner_table` text NOT NULL,
	`owner_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_owner_table_owner_id_idx` ON `attachments` (`owner_table`,`owner_id`);--> statement-breakpoint
CREATE INDEX `attachments_business_id_idx` ON `attachments` (`business_id`);--> statement-breakpoint
CREATE INDEX `attachments_org_id_idx` ON `attachments` (`org_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`actor` text NOT NULL,
	`device_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_table_name_row_id_idx` ON `audit_log` (`table_name`,`row_id`);--> statement-breakpoint
CREATE INDEX `audit_log_business_id_idx` ON `audit_log` (`business_id`);--> statement-breakpoint
CREATE INDEX `audit_log_org_id_idx` ON `audit_log` (`org_id`);--> statement-breakpoint
CREATE TABLE `batches` (
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
	`batch_no` text NOT NULL,
	`mfg_date` text,
	`expiry_date` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `batches_item_id_idx` ON `batches` (`item_id`);--> statement-breakpoint
CREATE INDEX `batches_business_id_idx` ON `batches` (`business_id`);--> statement-breakpoint
CREATE INDEX `batches_org_id_idx` ON `batches` (`org_id`);--> statement-breakpoint
CREATE TABLE `business_accounts` (
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
	`name` text NOT NULL,
	`account_no` text,
	`ifsc` text,
	`upi_id` text,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `business_accounts_business_id_idx` ON `business_accounts` (`business_id`);--> statement-breakpoint
CREATE INDEX `business_accounts_org_id_idx` ON `business_accounts` (`org_id`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`gstin` text,
	`legal_name` text NOT NULL,
	`trade_name` text,
	`address` text,
	`state_code` text NOT NULL,
	`pan` text,
	`scheme` text DEFAULT 'regular' NOT NULL,
	`fy_start_month` integer DEFAULT 4 NOT NULL,
	`preset` text,
	`settings_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `businesses_gstin_idx` ON `businesses` (`gstin`);--> statement-breakpoint
CREATE INDEX `businesses_org_id_idx` ON `businesses` (`org_id`);--> statement-breakpoint
CREATE TABLE `devices` (
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
	`platform` text,
	`last_seen_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `devices_business_id_idx` ON `devices` (`business_id`);--> statement-breakpoint
CREATE INDEX `devices_org_id_idx` ON `devices` (`org_id`);--> statement-breakpoint
CREATE TABLE `document_lines` (
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
	`line_no` integer NOT NULL,
	`item_id` text,
	`description` text,
	`hsn` text,
	`qty_micros` integer DEFAULT 1000000 NOT NULL,
	`unit_id` text,
	`rate_paise` integer DEFAULT 0 NOT NULL,
	`discount_mode` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`taxable_paise` integer DEFAULT 0 NOT NULL,
	`cgst_bp` integer DEFAULT 0 NOT NULL,
	`sgst_bp` integer DEFAULT 0 NOT NULL,
	`igst_bp` integer DEFAULT 0 NOT NULL,
	`utgst_bp` integer DEFAULT 0 NOT NULL,
	`cess_bp` integer DEFAULT 0 NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`utgst_paise` integer DEFAULT 0 NOT NULL,
	`cess_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer DEFAULT 0 NOT NULL,
	`batch_id` text,
	`serials_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `document_lines_document_id_idx` ON `document_lines` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_lines_item_id_idx` ON `document_lines` (`item_id`);--> statement-breakpoint
CREATE INDEX `document_lines_business_id_idx` ON `document_lines` (`business_id`);--> statement-breakpoint
CREATE INDEX `document_lines_org_id_idx` ON `document_lines` (`org_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`number` text,
	`series_id` text,
	`date` text NOT NULL,
	`due_date` text,
	`party_id` text,
	`party_name` text,
	`place_of_supply_state` text,
	`supply_type` text DEFAULT 'intra' NOT NULL,
	`reverse_charge` integer DEFAULT false NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`fx_rate_micros` integer DEFAULT 1000000 NOT NULL,
	`total_taxable_paise` integer DEFAULT 0 NOT NULL,
	`total_cgst_paise` integer DEFAULT 0 NOT NULL,
	`total_sgst_paise` integer DEFAULT 0 NOT NULL,
	`total_igst_paise` integer DEFAULT 0 NOT NULL,
	`total_utgst_paise` integer DEFAULT 0 NOT NULL,
	`total_cess_paise` integer DEFAULT 0 NOT NULL,
	`tcs_paise` integer DEFAULT 0 NOT NULL,
	`tds_paise` integer DEFAULT 0 NOT NULL,
	`round_off_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`terms` text,
	`template_id` text,
	`irn` text,
	`irn_ack_no` text,
	`irn_ack_date` text,
	`irn_signed_qr` text,
	`eway_bill_no` text,
	`eway_valid_until` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`source_document_id` text,
	`metadata_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_business_id_type_number_uq` ON `documents` (`business_id`,`type`,`number`) WHERE status <> 'draft' AND number IS NOT NULL;--> statement-breakpoint
CREATE INDEX `documents_business_id_type_date_idx` ON `documents` (`business_id`,`type`,`date`);--> statement-breakpoint
CREATE INDEX `documents_party_id_idx` ON `documents` (`party_id`);--> statement-breakpoint
CREATE INDEX `documents_business_id_idx` ON `documents` (`business_id`);--> statement-breakpoint
CREATE INDEX `documents_org_id_idx` ON `documents` (`org_id`);--> statement-breakpoint
CREATE TABLE `godowns` (
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
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `godowns_business_id_idx` ON `godowns` (`business_id`);--> statement-breakpoint
CREATE INDEX `godowns_org_id_idx` ON `godowns` (`org_id`);--> statement-breakpoint
CREATE TABLE `hsn_master` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`code` text NOT NULL,
	`description` text NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`cess_bp` integer DEFAULT 0 NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`source_version` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hsn_master_code_effective_from_uq` ON `hsn_master` (`code`,`effective_from`);--> statement-breakpoint
CREATE TABLE `item_variants` (
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
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`sale_rate_paise` integer,
	`attrs_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_variants_item_id_idx` ON `item_variants` (`item_id`);--> statement-breakpoint
CREATE INDEX `item_variants_business_id_idx` ON `item_variants` (`business_id`);--> statement-breakpoint
CREATE INDEX `item_variants_org_id_idx` ON `item_variants` (`org_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`kind` text DEFAULT 'goods' NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`hsn` text,
	`unit_id` text,
	`sale_rate_paise` integer DEFAULT 0 NOT NULL,
	`purchase_rate_paise` integer DEFAULT 0 NOT NULL,
	`gst_rate_bp` integer DEFAULT 0 NOT NULL,
	`cess_bp` integer DEFAULT 0 NOT NULL,
	`track_stock` integer DEFAULT false NOT NULL,
	`min_stock_micros` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_business_id_sku_idx` ON `items` (`business_id`,`sku`);--> statement-breakpoint
CREATE INDEX `items_business_id_barcode_idx` ON `items` (`business_id`,`barcode`);--> statement-breakpoint
CREATE INDEX `items_business_id_idx` ON `items` (`business_id`);--> statement-breakpoint
CREATE INDEX `items_org_id_idx` ON `items` (`org_id`);--> statement-breakpoint
CREATE TABLE `ledger_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`is_system` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `ledger_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_accounts_business_id_code_uq` ON `ledger_accounts` (`business_id`,`code`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `ledger_accounts_business_id_idx` ON `ledger_accounts` (`business_id`);--> statement-breakpoint
CREATE INDEX `ledger_accounts_org_id_idx` ON `ledger_accounts` (`org_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`document_id` text,
	`payment_id` text,
	`account_id` text NOT NULL,
	`debit_paise` integer DEFAULT 0 NOT NULL,
	`credit_paise` integer DEFAULT 0 NOT NULL,
	`date` text NOT NULL,
	`narration` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `ledger_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_account_id_date_idx` ON `ledger_entries` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `ledger_entries_document_id_idx` ON `ledger_entries` (`document_id`);--> statement-breakpoint
CREATE INDEX `ledger_entries_business_id_idx` ON `ledger_entries` (`business_id`);--> statement-breakpoint
CREATE INDEX `ledger_entries_org_id_idx` ON `ledger_entries` (`org_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`user_id` text NOT NULL,
	`business_id` text,
	`role` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memberships_user_id_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_org_id_idx` ON `memberships` (`org_id`);--> statement-breakpoint
CREATE TABLE `number_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`series_id` text NOT NULL,
	`device_id` text,
	`from_number` integer NOT NULL,
	`to_number` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `number_reservations_series_id_idx` ON `number_reservations` (`series_id`);--> statement-breakpoint
CREATE INDEX `number_reservations_business_id_idx` ON `number_reservations` (`business_id`);--> statement-breakpoint
CREATE INDEX `number_reservations_org_id_idx` ON `number_reservations` (`org_id`);--> statement-breakpoint
CREATE TABLE `number_series` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`document_type` text NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`suffix` text DEFAULT '' NOT NULL,
	`padding` integer DEFAULT 4 NOT NULL,
	`reset` text DEFAULT 'fy' NOT NULL,
	`fy` text,
	`next_number` integer DEFAULT 1 NOT NULL,
	`reserved_ranges_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `number_series_business_id_document_type_prefix_fy_idx` ON `number_series` (`business_id`,`document_type`,`prefix`,`fy`);--> statement-breakpoint
CREATE INDEX `number_series_business_id_idx` ON `number_series` (`business_id`);--> statement-breakpoint
CREATE INDEX `number_series_org_id_idx` ON `number_series` (`org_id`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`trade_name` text,
	`gstin` text,
	`pan` text,
	`phone` text,
	`email` text,
	`state_code` text,
	`addresses_json` text,
	`contacts_json` text,
	`credit_days` integer DEFAULT 0 NOT NULL,
	`opening_balance_paise` integer DEFAULT 0 NOT NULL,
	`is_sez` integer DEFAULT false NOT NULL,
	`is_export` integer DEFAULT false NOT NULL,
	`is_unregistered` integer DEFAULT false NOT NULL,
	`is_composition` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parties_business_id_gstin_idx` ON `parties` (`business_id`,`gstin`);--> statement-breakpoint
CREATE INDEX `parties_business_id_name_idx` ON `parties` (`business_id`,`name`);--> statement-breakpoint
CREATE INDEX `parties_business_id_idx` ON `parties` (`business_id`);--> statement-breakpoint
CREATE INDEX `parties_org_id_idx` ON `parties` (`org_id`);--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`payment_id` text NOT NULL,
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
CREATE INDEX `payment_allocations_payment_id_idx` ON `payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_document_id_idx` ON `payment_allocations` (`document_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_business_id_idx` ON `payment_allocations` (`business_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_org_id_idx` ON `payment_allocations` (`org_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`date` text NOT NULL,
	`mode` text NOT NULL,
	`account_id` text,
	`party_id` text,
	`amount_paise` integer NOT NULL,
	`reference` text,
	`status` text DEFAULT 'cleared' NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `business_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_party_id_idx` ON `payments` (`party_id`);--> statement-breakpoint
CREATE INDEX `payments_business_id_idx` ON `payments` (`business_id`);--> statement-breakpoint
CREATE INDEX `payments_org_id_idx` ON `payments` (`org_id`);--> statement-breakpoint
CREATE TABLE `rate_master_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`effective_from` text NOT NULL,
	`source` text,
	`notes` text,
	`published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_master_versions_version_unique` ON `rate_master_versions` (`version`);--> statement-breakpoint
CREATE TABLE `review_items` (
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
	`status` text DEFAULT 'pending' NOT NULL,
	`payload_json` text,
	`suggestion_json` text,
	`diff_json` text,
	`correction_json` text,
	`source` text,
	`model` text,
	`confidence` integer,
	`accepted_by` text,
	`accepted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_items_business_id_status_idx` ON `review_items` (`business_id`,`status`);--> statement-breakpoint
CREATE INDEX `review_items_business_id_idx` ON `review_items` (`business_id`);--> statement-breakpoint
CREATE INDEX `review_items_org_id_idx` ON `review_items` (`org_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`key` text NOT NULL,
	`value_json` text,
	`scope` text DEFAULT 'business' NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_business_id_scope_key_uq` ON `settings` (`business_id`,`scope`,`key`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `settings_business_id_idx` ON `settings` (`business_id`);--> statement-breakpoint
CREATE INDEX `settings_org_id_idx` ON `settings` (`org_id`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
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
	`variant_id` text,
	`godown_id` text,
	`batch_id` text,
	`kind` text NOT NULL,
	`qty_micros` integer NOT NULL,
	`rate_paise` integer,
	`document_id` text,
	`date` text NOT NULL,
	`note` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `item_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`godown_id`) REFERENCES `godowns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_movements_item_id_date_idx` ON `stock_movements` (`item_id`,`date`);--> statement-breakpoint
CREATE INDEX `stock_movements_document_id_idx` ON `stock_movements` (`document_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_business_id_idx` ON `stock_movements` (`business_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_org_id_idx` ON `stock_movements` (`org_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`device_id` text,
	`cursor` text,
	`last_synced_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_state_org_id_idx` ON `sync_state` (`org_id`);--> statement-breakpoint
CREATE TABLE `templates` (
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
	`kind` text DEFAULT 'document' NOT NULL,
	`config_json` text,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `templates_business_id_idx` ON `templates` (`business_id`);--> statement-breakpoint
CREATE INDEX `templates_org_id_idx` ON `templates` (`org_id`);--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`is_custom` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `units_business_id_code_uq` ON `units` (`business_id`,`code`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `units_business_id_idx` ON `units` (`business_id`);--> statement-breakpoint
CREATE INDEX `units_org_id_idx` ON `units` (`org_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`locale` text DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);