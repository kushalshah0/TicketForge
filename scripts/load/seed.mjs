import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { hash } from 'argon2';
import { importPKCS8, SignJWT } from 'jose';

assert.equal(
  process.env.READINESS_PROJECT,
  'tf-readiness-20261029',
  'Run only on the isolated readiness network',
);
const key = await importPKCS8(
  readFileSync('/fixtures/keys/private.pem', 'utf8'),
  'RS256',
);
const users = Array.from({ length: 500 }, (_, i) => ({
  id: randomUUID(),
  email: `load-${i}@example.test`,
  displayName: `Load user ${i}`,
}));
const auth = new Pool({
  connectionString: `postgresql://auth_svc:${process.env.AUTH_DB_PASSWORD}@postgres:5432/auth`,
});
const notification = new Pool({
  connectionString: `postgresql://notification_svc:${process.env.NOTIFICATION_DB_PASSWORD}@postgres:5432/notification`,
});
try {
  const passwordHash = await hash(process.env.SEED_PASSWORD);
  await auth.query(
    `
    INSERT INTO users (id,email,password_hash,role,display_name)
    SELECT id::uuid,email,$2,'customer', "displayName"
    FROM json_to_recordset($1::json) AS u(id text,email text,"displayName" text)
  `,
    [JSON.stringify(users), passwordHash],
  );
  await notification.query(
    `
    INSERT INTO recipients (user_id,email,display_name,role)
    SELECT id::uuid,email,"displayName",'customer'
    FROM json_to_recordset($1::json) AS u(id text,email text,"displayName" text)
  `,
    [JSON.stringify(users)],
  );
} finally {
  await auth.end();
  await notification.end();
}
const request = async (path, options = {}) => {
  const response = await fetch(`http://gateway:3000/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `Seed request ${path} failed with ${response.status}`);
  return response.json();
};
const organizer = await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email: `load-organizer-${randomUUID()}@example.test`,
    password: process.env.SEED_PASSWORD,
    displayName: 'Load organizer',
    role: 'organizer',
  }),
});
const tierId = randomUUID();
const event = await request('/events', {
  method: 'POST',
  headers: { authorization: `Bearer ${organizer.accessToken}` },
  body: JSON.stringify({
    title: 'LOAD-TEST-100',
    description: 'Isolated readiness test',
    venueName: 'Scratch hall',
    city: 'Kathmandu',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    tiers: [{ id: tierId, name: 'General', priceMinor: 1000 }],
    layout: {
      sections: [
        { id: randomUUID(), name: 'Floor', tierId, rows: 10, seatsPerRow: 10 },
      ],
    },
  }),
});
await request(`/events/${event.id}/publish`, {
  method: 'POST',
  headers: { authorization: `Bearer ${organizer.accessToken}` },
});
let seats;
for (let i = 0; i < 60; i++) {
  const response = await fetch(
    `http://gateway:3000/api/events/${event.id}/availability`,
  );
  if (response.ok) {
    seats = (await response.json()).sections.flatMap((s) =>
      s.seats.map((seat) => seat.seatId),
    );
    if (seats.length === 100) break;
  } else {
    assert.equal(response.status, 404);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(seats?.length, 100);
const tokens = await Promise.all(
  users.map((user) =>
    new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256', kid: process.env.JWT_KEY_ID })
      .setSubject(user.id)
      .setIssuer(process.env.JWT_ISSUER)
      .setAudience(process.env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(key),
  ),
);
writeFileSync(
  '/fixtures/load.json',
  JSON.stringify({ eventId: event.id, seats, tokens }),
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Seeded 500 users directly, signed test tokens, and published a 100-seat event.',
);
