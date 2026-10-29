import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EventEnvelope } from '@tf/contracts';

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: uuid('message_id').notNull().unique(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<EventEnvelope>().notNull(),
    headers: jsonb('headers')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    index('outbox_unpublished_idx')
      .on(table.id)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);
