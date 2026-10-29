import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { connect } from 'amqplib';
import { readBookingInvariantViolations } from '../libs/testing/src/booking-invariants.ts';

const services = ['auth', 'catalog', 'booking', 'payment', 'notification'];
const deadLetterQueues = [
  'booking.catalog-events.dlq',
  'booking.payment-events.dlq',
  'payment.booking-events.dlq',
  'notification.events.dlq',
];

export function auditConfig(env) {
  const required = (name) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name} before running the audit`);
    const protocols =
      name === 'AUDIT_AMQP_URL'
        ? ['amqp:', 'amqps:']
        : ['postgres:', 'postgresql:'];
    if (!URL.canParse(value) || !protocols.includes(new URL(value).protocol)) {
      throw new Error(`Invalid connection URL in ${name}`);
    }
    return value;
  };
  return {
    databases: Object.fromEntries(
      services.map((service) => [
        service,
        required(`AUDIT_${service.toUpperCase()}_DATABASE_URL`),
      ]),
    ),
    amqpUrl: required('AUDIT_AMQP_URL'),
  };
}

async function readDatabase(connectionString, read) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000',
  });
  try {
    await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await pool.query(`
      SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR has_schema_privilege('public', 'CREATE')
        OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
          AND has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ) AS writable
      FROM pg_roles WHERE rolname=current_user
    `);
    if (rows[0]?.writable !== false) {
      throw new Error('Audit requires a dedicated read-only database role');
    }
    return await read(pool);
  } finally {
    // Closing the only connection rolls back its read-only snapshot.
    await pool.end();
  }
}

export async function readDeadLetterQueues(channel) {
  const violations = {};
  for (const name of deadLetterQueues) {
    const queue = await channel.checkQueue(name);
    if (queue.consumerCount !== 0) {
      throw new Error(
        `Stop consumers of ${name} before auditing its full depth`,
      );
    }
    if (!Number.isSafeInteger(queue.messageCount) || queue.messageCount < 0) {
      throw new Error(`Invalid dead-letter queue statistics for ${name}`);
    }
    violations[`dlq.${name}`] = queue.messageCount;
  }
  return violations;
}

export async function runAudit(config) {
  const violations = {};
  let confirmedBookings;
  let payments;
  for (const service of services) {
    await readDatabase(config.databases[service], async (pool) => {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS count FROM outbox
        WHERE published_at IS NULL AND created_at < now() - interval '5 minutes'
      `);
      violations[`${service}.staleOutbox`] = rows[0].count;
      if (service === 'booking') {
        Object.assign(violations, await readBookingInvariantViolations(pool));
        ({ rows: confirmedBookings } = await pool.query(`
          SELECT id, payment_id, total_minor, currency
          FROM bookings WHERE status='CONFIRMED'
        `));
      }
      if (service === 'payment') {
        ({ rows: payments } = await pool.query(`
          SELECT p.id, p.booking_id, p.amount_minor, p.currency, p.status,
            r.amount_minor AS refund_amount
          FROM payments p LEFT JOIN refunds r ON r.payment_id=p.id
          WHERE p.status IN ('SUCCEEDED', 'REFUNDED')
        `));
      }
    });
  }

  // shortcut: settlement IDs are held in memory, paginate reconciliation if data outgrows the ops runner.
  const paymentsByBooking = new Map();
  for (const payment of payments) {
    const matches = paymentsByBooking.get(payment.booking_id) ?? [];
    matches.push(payment);
    paymentsByBooking.set(payment.booking_id, matches);
  }
  violations.confirmedWithoutMatchingPayment = confirmedBookings.filter(
    (booking) => {
      const matches = paymentsByBooking.get(booking.id) ?? [];
      return (
        matches.length !== 1 ||
        matches[0].status !== 'SUCCEEDED' ||
        matches[0].id !== booking.payment_id ||
        matches[0].amount_minor !== booking.total_minor ||
        matches[0].currency.trim() !== booking.currency.trim()
      );
    },
  ).length;
  const confirmedIds = new Set(confirmedBookings.map((booking) => booking.id));
  violations.unconfirmedWithoutRefund = payments.filter(
    (payment) =>
      !confirmedIds.has(payment.booking_id) &&
      payment.refund_amount !== payment.amount_minor,
  ).length;

  const connection = await connect(config.amqpUrl, { timeout: 5_000 });
  try {
    const channel = await connection.createChannel();
    Object.assign(violations, await readDeadLetterQueues(channel));
  } finally {
    await connection.close();
  }
  return {
    ok: Object.values(violations).every((count) => count === 0),
    violations,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await runAudit(auditConfig(process.env));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
