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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
]);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookingId: uuid('booking_id').notNull(),
    userId: uuid('user_id').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    providerRef: text('provider_ref'),
    scenario: text('scenario'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('payments_booking_id_unique').on(table.bookingId),
    check('payments_amount_minor_check', sql`${table.amountMinor} >= 0`),
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
      .$type<{ paymentId: string; status: string }>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    amountMinor: integer('amount_minor').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('refunds_payment_id_unique').on(table.paymentId),
    check('refunds_amount_minor_check', sql`${table.amountMinor} >= 0`),
  ],
);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  providerEventId: text('provider_event_id').primaryKey(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    messageId: uuid('message_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    unique('outbox_message_id_unique').on(table.messageId),
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
