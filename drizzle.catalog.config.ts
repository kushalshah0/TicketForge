import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/catalog/src/database/schema.ts',
  out: './apps/catalog/migrations',
  dbCredentials: {
    url:
      process.env.CATALOG_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://localhost/ticketforge_catalog',
  },
});
