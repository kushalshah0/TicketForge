import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Pool } from 'pg';
import { auditConfig, readDeadLetterQueues, runAudit } from './audit.mjs';

test('audit configuration rejects missing credentials', () => {
  assert.throws(() => auditConfig({}), /Set AUDIT_AUTH_DATABASE_URL/);
  assert.throws(
    () =>
      auditConfig({
        AUDIT_AUTH_DATABASE_URL: 'not-a-connection-url',
      }),
    /Invalid connection URL in AUDIT_AUTH_DATABASE_URL/,
  );
});

test('nonempty, consumed, missing, and malformed DLQs cannot pass', async () => {
  const nonempty = await readDeadLetterQueues({
    checkQueue: async () => ({ messageCount: 1, consumerCount: 0 }),
  });
  assert.equal(Object.keys(nonempty).length, 4);
  assert.ok(Object.values(nonempty).every((count) => count === 1));
  await assert.rejects(
    readDeadLetterQueues({
      checkQueue: async () => ({ messageCount: 0, consumerCount: 1 }),
    }),
    /Stop consumers/,
  );
  await assert.rejects(
    readDeadLetterQueues({
      checkQueue: async () => ({ messageCount: '0', consumerCount: 0 }),
    }),
    /Invalid dead-letter queue statistics/,
  );
  await assert.rejects(
    readDeadLetterQueues({
      checkQueue: async () => {
        throw new Error('NOT_FOUND');
      },
    }),
    /NOT_FOUND/,
  );
});

test(
  'read-only audit detects deliberate scratch corruption',
  {
    skip: process.env.RUN_INTEGRATION_TESTS !== 'true',
    timeout: 90_000,
  },
  async (t) => {
    assert.ok(
      process.env.TEST_POSTGRES_ADMIN_URL,
      'Set TEST_POSTGRES_ADMIN_URL',
    );
    const admin = new Pool({
      connectionString: process.env.TEST_POSTGRES_ADMIN_URL,
    });
    const suffix = randomUUID().replaceAll('-', '');
    const role = `tf_audit_${suffix}`;
    const password = randomUUID();
    const databases = {};
    const pools = {};
    assert.ok(
      process.env.AMQP_URL,
      'Set AMQP_URL for the isolated test broker',
    );
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      for (const service of [
        'auth',
        'catalog',
        'booking',
        'payment',
        'notification',
      ]) {
        const name = `tf_test_audit_${suffix}_${service}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        const url = new URL(process.env.TEST_POSTGRES_ADMIN_URL);
        url.pathname = `/${name}`;
        pools[service] = new Pool({ connectionString: url.toString() });
        await pools[service].query(`
        CREATE TABLE outbox (published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
      `);
        if (service === 'booking') {
          await pools[service].query(`
          CREATE TABLE bookings (id text PRIMARY KEY, payment_id text, total_minor int, currency text, status text);
          CREATE TABLE seats (status text, booking_id text);
          CREATE TABLE booking_items (booking_id text, event_id text, seat_id text);
          INSERT INTO bookings VALUES ('b1','p1',100,'NPR','CONFIRMED');
        `);
        }
        if (service === 'payment') {
          await pools[service].query(`
          CREATE TABLE payments (id text PRIMARY KEY, booking_id text, amount_minor int, currency text, status text);
          CREATE TABLE refunds (payment_id text, amount_minor int);
          INSERT INTO payments VALUES ('p1','b1',100,'NPR','SUCCEEDED');
        `);
        }
        await pools[service].query(
          `GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`,
        );
        url.username = role;
        url.password = password;
        databases[service] = url.toString();
      }
      const config = {
        databases,
        amqpUrl: process.env.AMQP_URL,
      };
      await t.test('healthy scratch data and empty queues pass', async () => {
        assert.equal((await runAudit(config)).ok, true);
      });
      const cliEnv = {
        ...process.env,
        AUDIT_AMQP_URL: config.amqpUrl,
        ...Object.fromEntries(
          Object.entries(databases).map(([service, url]) => [
            `AUDIT_${service.toUpperCase()}_DATABASE_URL`,
            url,
          ]),
        ),
      };
      await t.test('CLI exits zero for clean data', () => {
        const result = spawnSync(process.execPath, ['scripts/audit.mjs'], {
          env: cliEnv,
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).ok, true);
      });
      await t.test('read-only credentials cannot mutate data', async () => {
        const pool = new Pool({ connectionString: databases.booking });
        try {
          await assert.rejects(
            pool.query('DELETE FROM bookings'),
            /permission denied/,
          );
        } finally {
          await pool.end();
        }
      });
      await t.test('privileged credentials are rejected', async () => {
        const url = new URL(process.env.TEST_POSTGRES_ADMIN_URL);
        url.pathname = new URL(databases.auth).pathname;
        await assert.rejects(
          runAudit({
            ...config,
            databases: { ...databases, auth: url.toString() },
          }),
          /dedicated read-only database role/,
        );
      });
      await t.test(
        'amount, currency, and payment identity mismatches fail',
        async () => {
          for (const [column, value] of [
            ['amount_minor', '101'],
            ['currency', "'USD'"],
            ['id', "'wrong-id'"],
          ]) {
            await pools.payment.query(`UPDATE payments SET ${column}=${value}`);
            try {
              const result = await runAudit(config);
              assert.equal(result.ok, false);
              assert.equal(
                result.violations.confirmedWithoutMatchingPayment,
                1,
              );
            } finally {
              await pools.payment.query(
                "UPDATE payments SET id='p1', amount_minor=100, currency='NPR'",
              );
            }
          }
        },
      );
      await t.test(
        'confirmed bookings require exactly one succeeded payment',
        async () => {
          for (const status of ['PENDING', 'FAILED', 'REFUNDED']) {
            await pools.payment.query('UPDATE payments SET status=$1', [
              status,
            ]);
            try {
              const result = await runAudit(config);
              assert.equal(result.ok, false);
              assert.equal(
                result.violations.confirmedWithoutMatchingPayment,
                1,
              );
            } finally {
              await pools.payment.query(
                "UPDATE payments SET status='SUCCEEDED'",
              );
            }
          }
          await pools.payment.query(
            "INSERT INTO payments VALUES ('p2','b1',100,'NPR','SUCCEEDED')",
          );
          try {
            const result = await runAudit(config);
            assert.equal(result.ok, false);
            assert.equal(result.violations.confirmedWithoutMatchingPayment, 1);
          } finally {
            await pools.payment.query("DELETE FROM payments WHERE id='p2'");
          }
        },
      );
      await t.test(
        'missing successful payment and absent refund fail',
        async () => {
          await pools.payment.query(
            "UPDATE payments SET booking_id='missing-booking'",
          );
          try {
            const result = await runAudit(config);
            assert.equal(result.ok, false);
            assert.equal(result.violations.confirmedWithoutMatchingPayment, 1);
            assert.equal(result.violations.unconfirmedWithoutRefund, 1);
            const cli = spawnSync(process.execPath, ['scripts/audit.mjs'], {
              env: cliEnv,
              encoding: 'utf8',
              timeout: 15_000,
            });
            assert.equal(cli.status, 1);
            assert.equal(JSON.parse(cli.stdout).ok, false);
            await pools.payment.query("INSERT INTO refunds VALUES ('p1',100)");
            assert.equal(
              (await runAudit(config)).violations.unconfirmedWithoutRefund,
              0,
            );
          } finally {
            await pools.payment.query(
              "DELETE FROM refunds; UPDATE payments SET booking_id='b1'",
            );
          }
        },
      );
      await t.test(
        'all three existing seat invariants detect corruption',
        async () => {
          await pools.booking.query(`
        INSERT INTO bookings VALUES ('b2',NULL,100,'NPR','EXPIRED'), ('b3',NULL,100,'NPR','CONFIRMED');
        INSERT INTO seats VALUES ('HELD',NULL), ('HELD','b2');
        INSERT INTO booking_items VALUES ('b1','event','A1'), ('b3','event','A1');
      `);
          try {
            const result = await runAudit(config);
            assert.equal(result.ok, false);
            assert.equal(result.violations.heldSeatsWithoutBooking, 1);
            assert.equal(result.violations.heldSeatsForInactiveBooking, 1);
            assert.equal(result.violations.duplicateActiveBookingSeats, 1);
          } finally {
            await pools.booking.query(
              "DELETE FROM booking_items; DELETE FROM seats; DELETE FROM bookings WHERE id<>'b1'",
            );
          }
        },
      );
      await t.test(
        'each service detects stale but not recent or published outbox rows',
        async () => {
          for (const [service, pool] of Object.entries(pools)) {
            await pool.query(`
          INSERT INTO outbox VALUES (NULL, now() - interval '6 minutes'),
            (NULL, now()), (now(), now() - interval '1 hour');
        `);
            try {
              const result = await runAudit(config);
              assert.equal(result.ok, false);
              assert.equal(result.violations[`${service}.staleOutbox`], 1);
            } finally {
              await pool.query('DELETE FROM outbox');
            }
          }
        },
      );
    } finally {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
      try {
        for (const service of Object.keys(pools)) {
          const name = `tf_test_audit_${suffix}_${service}`;
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        }
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    }
  },
);
