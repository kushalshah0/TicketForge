ALTER TABLE "bookings" ALTER COLUMN "currency" SET DATA TYPE char(3);--> statement-breakpoint
ALTER TABLE "event_snapshots" ALTER COLUMN "currency" SET DATA TYPE char(3);--> statement-breakpoint
ALTER TABLE "event_snapshots" ALTER COLUMN "currency" SET DEFAULT 'NPR';