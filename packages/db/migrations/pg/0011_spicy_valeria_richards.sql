ALTER TABLE "number_reservations" DROP CONSTRAINT "number_reservations_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "number_reservations" ALTER COLUMN "device_id" SET DATA TYPE text;