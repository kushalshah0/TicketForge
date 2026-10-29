import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/auth/src/database/schema.ts',
  out: './apps/auth/migrations',
  dbCredentials: {
    url:
      process.env.AUTH_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://localhost/ticketforge_auth',
  },
});
