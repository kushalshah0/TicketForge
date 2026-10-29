import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const recipients = pgTable(
  'recipients',
  {
    userId: uuid('user_id').primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'recipients_role_check',
      sql`${table.role} IN ('customer', 'organizer')`,
    ),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => recipients.userId, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    sourceEventId: uuid('source_event_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    subject: text('subject'),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'notifications_status_check',
      sql`${table.status} IN ('PENDING', 'SENT')`,
    ),
    check(
      'notifications_sent_at_check',
      sql`(${table.status} = 'SENT') = (${table.sentAt} IS NOT NULL)`,
    ),
    unique('notifications_dedupe_key').on(
      table.type,
      table.sourceEventId,
      table.userId,
    ),
    index('notifications_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
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
