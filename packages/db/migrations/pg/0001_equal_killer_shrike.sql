ALTER TABLE "documents" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD COLUMN "used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "series_key" text;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "shell_default" text;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "start_number" integer DEFAULT 1 NOT NULL;