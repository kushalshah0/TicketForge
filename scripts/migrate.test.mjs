import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migrateService } from './migrate.mjs';

test('migrations reject unknown services and absent credentials', async () => {
  await assert.rejects(migrateService('../auth', {}), /Specify auth/);
  await assert.rejects(migrateService('auth', {}), /Set AUTH_DATABASE_URL/);
});

test(
  'all five migration journals apply twice to scratch databases',
  {
    skip: process.env.RUN_INTEGRATION_TESTS !== 'true',
    timeout: 90_000,
  },
  async () => {
    assert.ok(process.env.TEST_POSTGRES_ADMIN_URL);
    const admin = new Pool({
      connectionString: process.env.TEST_POSTGRES_ADMIN_URL,
    });
    try {
      for (const service of [
        'auth',
        'catalog',
        'booking',
        'payment',
        'notification',
      ]) {
        const name = `tf_test_migrate_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        try {
          const url = new URL(process.env.TEST_POSTGRES_ADMIN_URL);
          url.pathname = `/${name}`;
          const env = {
            [`${service.toUpperCase()}_DATABASE_URL`]: url.toString(),
          };
          await migrateService(service, env);
          await migrateService(service, env);
          const pool = new Pool({ connectionString: url.toString() });
          try {
            const result = await pool.query(
              'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
            );
            assert.ok(result.rows[0].count > 0);
            if (service === 'notification') {
              const constraints = await pool.query(`
              SELECT conname FROM pg_constraint WHERE conname IN (
                'recipients_role_check', 'notifications_status_check', 'notifications_sent_at_check'
              )
            `);
              assert.equal(constraints.rowCount, 3);
            }
          } finally {
            await pool.end();
          }
        } finally {
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        }
      }
    } finally {
      await admin.end();
    }
  },
);
