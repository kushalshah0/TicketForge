CREATE TYPE "public"."booking_status" AS ENUM('AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."seat_status" AS ENUM('AVAILABLE', 'HELD', 'SOLD', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('VALID', 'USED', 'VOID');--> statement-breakpoint
CREATE TABLE "booking_items" (
	"booking_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"seat_id" text NOT NULL,
	"price_minor" integer NOT NULL,
	CONSTRAINT "booking_items_booking_id_seat_id_pk" PRIMARY KEY("booking_id","seat_id"),
	CONSTRAINT "booking_items_price_minor_check" CHECK ("booking_items"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "booking_status" NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancel_reason" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_total_minor_check" CHECK ("bookings"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "event_snapshots" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"organizer_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"currency" text DEFAULT 'NPR' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_snapshots_status_check" CHECK ("event_snapshots"."status" IN ('PUBLISHED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"message_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_messages_message_id_consumer_pk" PRIMARY KEY("message_id","consumer")
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"event_id" uuid NOT NULL,
	"seat_id" text NOT NULL,
	"section_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"price_minor" integer NOT NULL,
	"status" "seat_status" DEFAULT 'AVAILABLE' NOT NULL,
	"booking_id" uuid,
	"held_until" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "seats_event_id_seat_id_pk" PRIMARY KEY("event_id","seat_id"),
	CONSTRAINT "seats_price_minor_check" CHECK ("seats"."price_minor" >= 0),
	CONSTRAINT "seats_booking_state_check" CHECK (("seats"."status" IN ('HELD', 'SOLD')) = ("seats"."booking_id" IS NOT NULL)),
	CONSTRAINT "seats_held_until_check" CHECK (("seats"."status" = 'HELD') = ("seats"."held_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"seat_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "ticket_status" DEFAULT 'VALID' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_event_snapshots_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_snapshots"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_event_id_event_snapshots_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_snapshots"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_user_idx" ON "bookings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_expiry_idx" ON "bookings" USING btree ("expires_at") WHERE "bookings"."status" = 'AWAITING_PAYMENT';--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("id") WHERE "outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seats_booking_idx" ON "seats" USING btree ("booking_id") WHERE "seats"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "seats_event_status_idx" ON "seats" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_active_seat_uq" ON "tickets" USING btree ("event_id","seat_id") WHERE "tickets"."status" <> 'VOID';