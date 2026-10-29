import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const seatStatus = pgEnum('seat_status', [
  'AVAILABLE',
  'HELD',
  'SOLD',
  'BLOCKED',
]);
export const bookingStatus = pgEnum('booking_status', [
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
]);
export const ticketStatus = pgEnum('ticket_status', ['VALID', 'USED', 'VOID']);

export const eventSnapshots = pgTable(
  'event_snapshots',
  {
    eventId: uuid('event_id').primaryKey(),
    organizerId: uuid('organizer_id').notNull(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('NPR'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'event_snapshots_status_check',
      sql`${table.status} IN ('PUBLISHED', 'CANCELLED')`,
    ),
  ],
);

export const seats = pgTable(
  'seats',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => eventSnapshots.eventId),
    seatId: text('seat_id').notNull(),
    sectionId: text('section_id').notNull(),
    tierId: text('tier_id').notNull(),
    priceMinor: integer('price_minor').notNull(),
    status: seatStatus('status').notNull().default('AVAILABLE'),
    bookingId: uuid('booking_id'),
    heldUntil: timestamp('held_until', { withTimezone: true }),
    version: integer('version').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.seatId] }),
    check('seats_price_minor_check', sql`${table.priceMinor} >= 0`),
    check(
      'seats_booking_state_check',
      sql`(${table.status} IN ('HELD', 'SOLD')) = (${table.bookingId} IS NOT NULL)`,
    ),
    check(
      'seats_held_until_check',
      sql`(${table.status} = 'HELD') = (${table.heldUntil} IS NOT NULL)`,
    ),
    index('seats_booking_idx')
      .on(table.bookingId)
      .where(sql`${table.bookingId} IS NOT NULL`),
    index('seats_event_status_idx').on(table.eventId, table.status),
  ],
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => eventSnapshots.eventId),
    paymentId: uuid('payment_id'),
    status: bookingStatus('status').notNull(),
    totalMinor: integer('total_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cancelReason: text('cancel_reason'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('bookings_total_minor_check', sql`${table.totalMinor} >= 0`),
    index('bookings_user_idx').on(table.userId, table.createdAt),
    index('bookings_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'AWAITING_PAYMENT'`),
  ],
);

export const bookingItems = pgTable(
  'booking_items',
  {
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    eventId: uuid('event_id').notNull(),
    seatId: text('seat_id').notNull(),
    priceMinor: integer('price_minor').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bookingId, table.seatId] }),
    check('booking_items_price_minor_check', sql`${table.priceMinor} >= 0`),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    eventId: uuid('event_id').notNull(),
    seatId: text('seat_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: ticketStatus('status').notNull().default('VALID'),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('tickets_active_seat_uq')
      .on(table.eventId, table.seatId)
      .where(sql`${table.status} <> 'VOID'`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body')
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    messageId: uuid('message_id').notNull().unique(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    headers: jsonb('headers')
      .notNull()
      .default({})
      .$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    index('outbox_unpublished_idx')
      .on(table.id)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);

export const processedMessages = pgTable(
  'processed_messages',
  {
    messageId: uuid('message_id').notNull(),
    consumer: text('consumer').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.consumer] })],
);
