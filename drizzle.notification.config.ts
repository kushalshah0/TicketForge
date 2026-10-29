import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/notification/src/database/schema.ts',
  out: './apps/notification/migrations',
  dbCredentials: {
    url:
      process.env.NOTIFICATION_DATABASE_URL ??
      'postgresql://localhost/ticketforge_notification',
  },
});
