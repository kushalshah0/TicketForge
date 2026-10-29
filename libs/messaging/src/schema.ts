import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const processedMessages = pgTable(
  'processed_messages',
  {
    messageId: uuid('message_id').notNull(),
    consumer: text('consumer').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.consumer] })],
);
