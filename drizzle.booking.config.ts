import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/booking/src/database/schema.ts',
  out: './apps/booking/migrations',
  dbCredentials: {
    url:
      process.env.BOOKING_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://localhost/ticketforge_booking',
  },
});
