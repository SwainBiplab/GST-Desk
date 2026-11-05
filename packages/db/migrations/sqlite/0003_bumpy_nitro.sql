ALTER TABLE `review_items` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `review_items` ADD `reject_reason` text;--> statement-breakpoint
ALTER TABLE `review_items` ADD `dedupe_key` text;--> statement-breakpoint
CREATE INDEX `review_items_business_id_kind_dedupe_key_idx` ON `review_items` (`business_id`,`kind`,`dedupe_key`);