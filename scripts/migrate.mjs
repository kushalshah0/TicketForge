import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export async function migrateService(service, env = process.env) {
  if (
    !['auth', 'catalog', 'booking', 'payment', 'notification'].includes(service)
  ) {
    throw new Error('Specify auth, catalog, booking, payment, or notification');
  }
  const name = `${service.toUpperCase()}_DATABASE_URL`;
  if (!env[name]) throw new Error(`Set ${name} before running migrations`);
  const pool = new Pool({
    connectionString: env[name],
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: resolve(`apps/${service}/migrations`),
    });
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/migrate.mjs <service>');
  await migrateService(process.argv[2]);
  console.log('Database migrations completed.');
}
