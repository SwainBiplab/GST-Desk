PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_number_reservations` (
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
	`used` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_number_reservations`("id", "org_id", "business_id", "version", "created_at", "updated_at", "deleted_at", "created_by", "updated_by", "series_id", "device_id", "from_number", "to_number", "used", "status") SELECT "id", "org_id", "business_id", "version", "created_at", "updated_at", "deleted_at", "created_by", "updated_by", "series_id", "device_id", "from_number", "to_number", "used", "status" FROM `number_reservations`;--> statement-breakpoint
DROP TABLE `number_reservations`;--> statement-breakpoint
ALTER TABLE `__new_number_reservations` RENAME TO `number_reservations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `number_reservations_series_id_idx` ON `number_reservations` (`series_id`);--> statement-breakpoint
CREATE INDEX `number_reservations_business_id_idx` ON `number_reservations` (`business_id`);--> statement-breakpoint
CREATE INDEX `number_reservations_org_id_idx` ON `number_reservations` (`org_id`);