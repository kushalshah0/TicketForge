import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { importPKCS8, SignJWT } from 'jose';

assert.equal(process.env.READINESS_PROJECT, 'tf-readiness-20261029');
const fixture = JSON.parse(readFileSync('/fixtures/load.json', 'utf8'));
const phase = process.argv[2];
const request = async (path, body) => {
  const response = await fetch(`http://gateway:3000/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${fixture.tokens[0]}`,
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `Probe ${path}: HTTP ${response.status}`);
  return response.json();
};
const waitFor = async (read, accept, attempts = 120) => {
  for (let i = 0; i < attempts; i++) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Probe did not converge within ${Math.floor((attempts * 500) / 1000)} seconds`,
  );
};
if (phase === 'refresh-tokens') {
  assert.ok(
    process.env.AUTH_DB_PASSWORD,
    'Missing isolated auth database password',
  );
  for (const name of ['JWT_KEY_ID', 'JWT_ISSUER', 'JWT_AUDIENCE']) {
    assert.ok(process.env[name], `Missing ${name}`);
  }
  const subjects = fixture.tokens.map((token) => {
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'Invalid fixture JWT');
    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    assert.equal(claims.role, 'customer');
    assert.ok(claims.sub);
    return claims.sub;
  });
  assert.equal(
    new Set(subjects).size,
    subjects.length,
    'Duplicate fixture user IDs',
  );
  const auth = new Pool({
    connectionString: `postgresql://auth_svc:${process.env.AUTH_DB_PASSWORD}@postgres:5432/auth`,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const users = await auth.query(
      'SELECT id::text FROM users WHERE id = ANY($1::uuid[]) AND role = $2',
      [subjects, 'customer'],
    );
    assert.equal(users.rowCount, subjects.length, 'Fixture users are missing');
  } finally {
    await auth.end();
  }
  const key = await importPKCS8(
    readFileSync('/fixtures/keys/private.pem', 'utf8'),
    'RS256',
  );
  fixture.tokens = await Promise.all(
    subjects.map((subject) =>
      new SignJWT({ role: 'customer' })
        .setProtectedHeader({ alg: 'RS256', kid: process.env.JWT_KEY_ID })
        .setSubject(subject)
        .setIssuer(process.env.JWT_ISSUER)
        .setAudience(process.env.JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(key),
    ),
  );
  writeFileSync('/fixtures/load.json', JSON.stringify(fixture));
  chmodSync('/fixtures/load.json', 0o600);
  console.log(`Refreshed ${fixture.tokens.length} isolated fixture JWTs.`);
} else if (phase === 'hold') {
  const availability = await request(`/events/${fixture.eventId}/availability`);
  const seat = availability.sections
    .flatMap((s) => s.seats)
    .find((s) => s.status === 'AVAILABLE');
  assert.ok(seat, 'No available scratch seat');
  const hold = await request('/bookings', {
    eventId: fixture.eventId,
    seatIds: [seat.seatId],
  });
  assert.ok(hold.bookingId);
  writeFileSync(
    '/fixtures/probe.json',
    JSON.stringify({ bookingId: hold.bookingId, seatId: seat.seatId }),
    { mode: 0o600 },
  );
  console.log('Isolated probe hold created.');
} else {
  assert.ok(
    [
      'pay-slow',
      'pay-duplicate',
      'database-recovered',
      'confirmed',
      'expired',
      'replay',
      'outbox-pending',
      'outbox-drained',
    ].includes(phase),
    'Unknown probe phase',
  );
  const probe = JSON.parse(readFileSync('/fixtures/probe.json', 'utf8'));
  if (['replay', 'outbox-pending', 'outbox-drained'].includes(phase)) {
    const { Pool } = await import('pg');
    const booking = new Pool({
      connectionString: `postgresql://booking_svc:${process.env.BOOKING_DB_PASSWORD}@postgres:5432/booking`,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      if (phase === 'replay') {
        const { connect } = await import('amqplib');
        const payment = new Pool({
          connectionString: `postgresql://payment_svc:${process.env.PAYMENT_DB_PASSWORD}@postgres:5432/payment`,
          max: 1,
          connectionTimeoutMillis: 5000,
        });
        let event;
        try {
          const result = await payment.query(
            "SELECT payload,headers,message_id FROM outbox WHERE type='payment.succeeded' AND payload->'data'->>'bookingId'=$1",
            [probe.bookingId],
          );
          assert.equal(result.rowCount, 1);
          event = result.rows[0];
        } finally {
          await payment.end();
        }
        const duplicateCount = async () => {
          const response = await fetch('http://booking:3003/metrics', {
            signal: AbortSignal.timeout(10000),
          });
          assert.ok(response.ok);
          const line = (await response.text())
            .split('\n')
            .find(
              (l) =>
                l.startsWith('mq_consumer_processed_total{') &&
                l.includes('queue="booking.payment-events"') &&
                l.includes('result="duplicate"'),
            );
          return line ? Number(line.split(' ').at(-1)) : 0;
        };
        const before = await duplicateCount();
        assert.ok(process.env.RABBITMQ_USER, 'Missing isolated RabbitMQ user');
        assert.ok(
          process.env.RABBITMQ_PASSWORD,
          'Missing isolated RabbitMQ password',
        );
        const brokerUrl = new URL('amqp://rabbitmq:5672');
        brokerUrl.username = process.env.RABBITMQ_USER;
        brokerUrl.password = process.env.RABBITMQ_PASSWORD;
        const connection = await connect(brokerUrl.toString());
        try {
          const channel = await connection.createConfirmChannel();
          try {
            await channel.checkQueue('booking.payment-events');
            channel.sendToQueue(
              'booking.payment-events',
              Buffer.from(JSON.stringify(event.payload)),
              {
                persistent: true,
                messageId: event.message_id,
                contentType: 'application/json',
                type: 'payment.succeeded',
                headers: event.headers,
              },
            );
            await channel.waitForConfirms();
            await waitFor(duplicateCount, (n) => n > before);
          } finally {
            await channel.close();
          }
        } finally {
          await connection.close();
        }
        const confirmations = await booking.query(
          "SELECT count(*)::int AS n FROM outbox WHERE type='booking.confirmed' AND payload->'data'->>'bookingId'=$1",
          [probe.bookingId],
        );
        const tickets = await booking.query(
          'SELECT count(*)::int AS n FROM tickets WHERE booking_id=$1',
          [probe.bookingId],
        );
        assert.equal(confirmations.rows[0].n, 1);
        assert.equal(tickets.rows[0].n, 1);
        console.log(
          'Replayed exact payment event; consumer recorded duplicate, one confirmation and one ticket remain.',
        );
      } else {
        const pending = async () =>
          (
            await booking.query(
              "SELECT count(*)::int AS n,coalesce(max(extract(epoch from now()-created_at)),0)::float AS age FROM outbox WHERE published_at IS NULL AND payload->'data'->>'bookingId'=$1",
              [probe.bookingId],
            )
          ).rows[0];
        if (phase === 'outbox-pending') {
          const result = await pending();
          assert.ok(
            result.n > 0 && result.age >= 100,
            'Expected aged unpublished booking events during outage',
          );
          console.log(
            'Booking outbox contains unpublished events older than 100 seconds.',
          );
        } else {
          await waitFor(pending, (r) => r.n === 0);
          console.log('Probe booking outbox drained.');
        }
      }
    } finally {
      await booking.end();
    }
  } else if (phase === 'database-recovered') {
    const booking = await request(`/bookings/${probe.bookingId}`);
    assert.equal(booking.id, probe.bookingId);
    assert.equal(booking.status, 'AWAITING_PAYMENT');
    assert.equal(booking.items?.length, 1);
    assert.equal(booking.items[0]?.seatId, probe.seatId);
    const availability = await request(
      `/events/${fixture.eventId}/availability`,
    );
    const seat = availability.sections
      .flatMap((s) => s.seats)
      .find((s) => s.seatId === probe.seatId);
    assert.equal(seat?.status, 'HELD');
    const catalog = await request(
      `/events?q=LOAD-TEST-100&from=${encodeURIComponent(new Date().toISOString())}`,
    );
    assert.ok(
      catalog.items.some((event) => event.id === fixture.eventId),
      'Catalog did not return the isolated event after database restart',
    );
    console.log(
      'Booking, inventory, and catalog reads recovered after the database restart.',
    );
  } else if (phase.startsWith('pay-')) {
    let payment;
    for (let i = 0; i < 60; i++) {
      const response = await fetch(
        `http://gateway:3000/api/payments/by-booking/${probe.bookingId}`,
        {
          headers: { authorization: `Bearer ${fixture.tokens[0]}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) {
        payment = await response.json();
        break;
      }
      assert.equal(response.status, 404);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(payment?.id, 'Probe payment not created');
    await request(`/payments/${payment.id}/pay`, {
      scenario: phase === 'pay-slow' ? 'slow' : 'duplicate',
    });
    console.log('Isolated probe payment accepted.');
  } else {
    const expected = phase === 'confirmed' ? 'CONFIRMED' : 'EXPIRED';
    await waitFor(
      () => request(`/bookings/${probe.bookingId}`),
      (b) => b.status === expected,
      phase === 'expired' ? 1320 : 120,
    );
    const availability = await request(
      `/events/${fixture.eventId}/availability`,
    );
    const seat = availability.sections
      .flatMap((s) => s.seats)
      .find((s) => s.seatId === probe.seatId);
    assert.equal(seat?.status, phase === 'confirmed' ? 'SOLD' : 'AVAILABLE');
    console.log(`Probe converged to ${expected} with matching inventory.`);
  }
}
