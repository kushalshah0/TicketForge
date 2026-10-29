import { sql } from 'drizzle-orm';
import {
  bigint,
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
  varchar,
} from 'drizzle-orm/pg-core';

export interface CatalogSection {
  id: string;
  name: string;
  tierId: string;
  rows: number;
  seatsPerRow: number;
}

export interface CatalogTier {
  id: string;
  name: string;
  priceMinor: number;
}

export interface CatalogLayout {
  sections: CatalogSection[];
}

export const eventStatus = pgEnum('event_status', [
  'DRAFT',
  'PUBLISHED',
  'CANCELLED',
]);

export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizerId: uuid('organizer_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull().default(''),
    venueName: varchar('venue_name', { length: 200 }).notNull(),
    city: varchar('city', { length: 120 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    status: eventStatus('status').notNull().default('DRAFT'),
    currency: varchar('currency', { length: 3 }).notNull().default('NPR'),
    layout: jsonb('layout')
      .$type<CatalogLayout>()
      .notNull()
      .default({ sections: [] }),
    tiers: jsonb('tiers').$type<CatalogTier[]>().notNull().default([]),
    versionNo: integer('version_no').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    index('events_organizer_created_idx').on(
      table.organizerId,
      table.createdAt,
    ),
    index('events_status_starts_at_idx').on(table.status, table.startsAt),
    index('events_title_trgm_idx').using(
      'gin',
      sql`${table.title} gin_trgm_ops`,
    ),
    index('events_city_trgm_idx').using('gin', sql`${table.city} gin_trgm_ops`),
  ],
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
    unique('outbox_message_id_key').on(table.messageId),
    index('outbox_unpublished_idx')
      .on(table.id)
      .where(sql`${table.publishedAt} is null`),
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
