ALTER TABLE `devices` ADD `kind` text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `role` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `token_hash` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `token_issued_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `prev_valid_until` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `revoked_at` integer;--> statement-breakpoint
CREATE INDEX `devices_token_hash_idx` ON `devices` (`token_hash`);