import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/payment/src/database/schema.ts',
  out: './apps/payment/migrations',
  dbCredentials: {
    url:
      process.env.PAYMENT_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://localhost/ticketforge_payment',
  },
});
