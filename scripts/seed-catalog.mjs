import { randomUUID } from 'node:crypto';

const apiUrl = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:3000';
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 10) {
  throw new Error('Set SEED_PASSWORD to a value with at least 10 characters.');
}

const users = [
  ...Array.from({ length: 2 }, (_, index) => ({
    email: `organizer-${index + 1}@ticketforge.example.test`,
    displayName: `Demo Organizer ${index + 1}`,
    role: 'organizer',
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    email: `customer-${index + 1}@ticketforge.example.test`,
    displayName: `Demo Customer ${index + 1}`,
    role: 'customer',
  })),
];

const sessions = await Promise.all(users.map(getOrCreateUser));
const organizers = sessions.filter((session) => session.role === 'organizer');
const seatCounts = [30, 40, 50, 60, 80, 100, 120, 150, 200, 100];
const cities = ['Kathmandu', 'Pokhara', 'Lalitpur', 'Bhaktapur'];

for (let index = 0; index < seatCounts.length; index += 1) {
  const title = index === 9 ? 'LOAD-TEST-100' : `TicketForge Demo Event ${String(index + 1).padStart(2, '0')}`;
  const organizer = organizers[index % organizers.length];
  if (!organizer) throw new Error('Organizer seed account was not created.');

  const existing = await apiRequest('/api/organizer/events', { token: organizer.token });
  let event = existing.find((candidate) => candidate.title === title);
  if (!event) {
    const tierId = randomUUID();
    const seats = seatCounts[index] ?? 30;
    const rows = Math.ceil(seats / 20);
    event = await apiRequest('/api/events', {
      method: 'POST',
      token: organizer.token,
      body: {
        title,
        description: `Demo event ${index + 1}`,
        venueName: 'TicketForge Hall',
        city: cities[index % cities.length],
        startsAt: new Date(Date.now() + (24 + index * 24) * 60 * 60 * 1_000).toISOString(),
        tiers: [{ id: tierId, name: 'General', priceMinor: 1_000 + index * 250 }],
        layout: {
          sections: [{ id: randomUUID(), name: 'General', tierId, rows, seatsPerRow: Math.ceil(seats / rows) }],
        },
      },
    });
  }

  if (event.status === 'DRAFT') {
    event = await apiRequest(`/api/events/${event.id}/publish`, {
      method: 'POST',
      token: organizer.token,
    });
  }
  if (event.status !== 'PUBLISHED') {
    throw new Error(`Seed event ${title} is in unexpected state ${event.status}.`);
  }
  console.log(`Ready: ${title}`);
}

console.log(`Seed complete: ${organizers.length} organizers, 3 customers, ${seatCounts.length} published events.`);

async function getOrCreateUser(user) {
  try {
    const session = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: { ...user, password },
    });
    return { role: user.role, token: session.accessToken };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
    const session = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password },
    });
    return { role: user.role, token: session.accessToken };
  }
}

async function apiRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new ApiError(response.status, result?.code ?? 'REQUEST_FAILED', result?.detail ?? 'Request failed');
  }
  return result;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
  }
}