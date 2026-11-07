CREATE TABLE `hsn_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`code` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`vector_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hsn_embeddings_code_model_uq` ON `hsn_embeddings` (`code`,`model`);