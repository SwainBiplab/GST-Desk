ALTER TABLE `documents` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `number_reservations` ADD `used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `number_series` ADD `name` text;--> statement-breakpoint
ALTER TABLE `number_series` ADD `series_key` text;--> statement-breakpoint
ALTER TABLE `number_series` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `number_series` ADD `shell_default` text;--> statement-breakpoint
ALTER TABLE `number_series` ADD `start_number` integer DEFAULT 1 NOT NULL;