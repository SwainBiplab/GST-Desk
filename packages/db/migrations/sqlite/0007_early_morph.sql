CREATE TABLE `einvoices` (
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
	`irn` text NOT NULL,
	`ack_no` text,
	`ack_date` text,
	`signed_invoice` text,
	`signed_qr` text,
	`status` text DEFAULT 'active' NOT NULL,
	`recovered` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`cancel_remarks` text,
	`cancelled_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `einvoices_business_id_document_id_uq` ON `einvoices` (`business_id`,`document_id`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `einvoices_business_id_idx` ON `einvoices` (`business_id`);--> statement-breakpoint
CREATE INDEX `einvoices_org_id_idx` ON `einvoices` (`org_id`);--> statement-breakpoint
CREATE TABLE `ewaybills` (
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
	`ewb_no` text NOT NULL,
	`generated_at` text NOT NULL,
	`valid_until` text,
	`status` text DEFAULT 'active' NOT NULL,
	`distance_km` integer,
	`trans_mode` text,
	`vehicle_no` text,
	`transporter_id` text,
	`from_place` text,
	`from_state` text,
	`from_pincode` text,
	`cancel_reason` text,
	`cancelled_at` text,
	`history_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ewaybills_business_id_ewb_no_idx` ON `ewaybills` (`business_id`,`ewb_no`);--> statement-breakpoint
CREATE INDEX `ewaybills_document_id_idx` ON `ewaybills` (`document_id`);--> statement-breakpoint
CREATE INDEX `ewaybills_business_id_idx` ON `ewaybills` (`business_id`);--> statement-breakpoint
CREATE INDEX `ewaybills_org_id_idx` ON `ewaybills` (`org_id`);--> statement-breakpoint
CREATE TABLE `gsp_jobs` (
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
	`document_id` text,
	`ewaybill_id` text,
	`idempotency_key` text NOT NULL,
	`payload_json` text,
	`args_json` text,
	`doc_revision` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer,
	`last_code` text,
	`last_message` text,
	`result_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ewaybill_id`) REFERENCES `ewaybills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsp_jobs_business_id_idempotency_key_uq` ON `gsp_jobs` (`business_id`,`idempotency_key`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `gsp_jobs_business_id_status_idx` ON `gsp_jobs` (`business_id`,`status`);--> statement-breakpoint
CREATE INDEX `gsp_jobs_business_id_idx` ON `gsp_jobs` (`business_id`);--> statement-breakpoint
CREATE INDEX `gsp_jobs_org_id_idx` ON `gsp_jobs` (`org_id`);--> statement-breakpoint
CREATE TABLE `gsp_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`business_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`created_by` text,
	`updated_by` text,
	`job_id` text,
	`document_id` text,
	`portal` text NOT NULL,
	`action` text NOT NULL,
	`request_json` text,
	`response_json` text,
	`ok` integer DEFAULT false NOT NULL,
	`code` text,
	`message` text,
	`ms` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `gsp_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gsp_log_business_id_document_id_idx` ON `gsp_log` (`business_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `gsp_log_job_id_idx` ON `gsp_log` (`job_id`);--> statement-breakpoint
CREATE INDEX `gsp_log_business_id_idx` ON `gsp_log` (`business_id`);--> statement-breakpoint
CREATE INDEX `gsp_log_org_id_idx` ON `gsp_log` (`org_id`);