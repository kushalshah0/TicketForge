import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const redisDatabase = new URL(redisUrl).pathname;
if (!/^\/(?:[1-9]|1[0-5])$/.test(redisDatabase)) {
  throw new Error('Gateway e2e requires a dedicated Redis database from 1 to 15');
}

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
const appPort = await getUnusedPort();
const authPort = await getUnusedPort();
const catalogPort = await getUnusedPort();
const bookingPort = await getUnusedPort();
const paymentPort = await getUnusedPort();
const notificationPort = await getUnusedPort();
const address = `http://127.0.0.1:${appPort}`;
const corsOrigin = 'https://allowed.example.test';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const organizerToken = await new SignJWT({ role: 'organizer' })
  .setProtectedHeader({ alg: 'RS256', kid: 'ticketforge-e2e' })
  .setSubject('organizer-e2e')
  .setIssuer('ticketforge-e2e')
  .setAudience('ticketforge-e2e')
  .setExpirationTime('5m')
  .sign(privateKey);
const customerToken = await new SignJWT({ role: 'customer' })
  .setProtectedHeader({ alg: 'RS256', kid: 'ticketforge-e2e' })
  .setSubject('customer-e2e')
  .setIssuer('ticketforge-e2e')
  .setAudience('ticketforge-e2e')
  .setExpirationTime('5m')
  .sign(privateKey);

let authServer;
let catalogServer;
let bookingServer;
let paymentServer;
let notificationServer;
let gateway;
let gatewayOutput = '';

try {
  await redis.flushdb();
  authServer = await startStub(authPort);
  catalogServer = await startStub(catalogPort);
  bookingServer = await startStub(bookingPort);
  paymentServer = await startStub(paymentPort);
  notificationServer = await startStub(notificationPort);
  gateway = spawn(process.execPath, ['dist/apps/gateway/main.js'], {
    env: {
      ...process.env,
      AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
      BOOKING_SERVICE_URL: `http://127.0.0.1:${bookingPort}`,
      CATALOG_SERVICE_URL: `http://127.0.0.1:${catalogPort}`,
      CORS_ORIGINS: corsOrigin,
      JWT_AUDIENCE: 'ticketforge-e2e',
      JWT_ISSUER: 'ticketforge-e2e',
      JWT_KEY_ID: 'ticketforge-e2e',
      JWT_PUBLIC_KEY: await exportSPKI(publicKey),
      LOAD_TEST_ALLOWLIST: '',
      NOTIFICATION_SERVICE_URL: `http://127.0.0.1:${notificationPort}`,
      PAYMENT_SERVICE_URL: `http://127.0.0.1:${paymentPort}`,
      PORT: String(appPort),
      REDIS_URL: redisUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout.setEncoding('utf8').on('data', (chunk) => (gatewayOutput += chunk));
  gateway.stderr.setEncoding('utf8').on('data', (chunk) => (gatewayOutput += chunk));
  await waitForGateway(address, gateway);

  await request(address)
    .get('/api/bookings')
    .expect(401)
    .expect('content-type', /application\/problem\+json/);

  await request(address)
    .post('/api/bookings')
    .set('authorization', `Bearer ${organizerToken}`)
    .send({})
    .expect(403)
    .expect('content-type', /application\/problem\+json/);

  for (const clientIp of ['198.51.100.11', '198.51.100.12']) {
    const response = await request(address)
      .get('/api/events')
      .set('x-forwarded-for', clientIp)
      .expect(200);
    assert.equal(response.headers['x-ratelimit-remaining'], '99');
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await request(address).post('/api/auth/login').send({}).expect(200);
  }
  const limited = await request(address).post('/api/auth/login').send({}).expect(429);
  assert.ok(Number(limited.headers['retry-after']) > 0);

  const secureResponse = await request(address)
    .get('/api/events')
    .set('origin', corsOrigin)
    .set('x-request-id', 'gateway-e2e-request')
    .expect(200);
  assert.equal(secureResponse.headers['x-content-type-options'], 'nosniff');
  assert.equal(secureResponse.headers['access-control-allow-origin'], corsOrigin);
  assert.equal(secureResponse.headers['x-request-id'], 'gateway-e2e-request');

  const healthy = await request(address).get('/api/health').expect(200);
  assert.equal(healthy.body.status, 'ok');
  assert.equal(healthy.body.gateway.status, 'up');
  assert.deepEqual(healthy.body.downstreams, {
    auth: 'up',
    catalog: 'up',
    booking: 'up',
    payment: 'up',
    notification: 'up',
  });

  await request(address)
    .post('/api/auth/login')
    .set('content-type', 'application/json')
    .send({ payload: 'x'.repeat(100 * 1024) })
    .expect(413);

  await closeServer(catalogServer);
  catalogServer = undefined;
  const unavailable = await request(address)
    .get('/api/events')
    .set('x-request-id', 'gateway-downstream-request')
    .expect(503)
    .expect('content-type', /application\/problem\+json/);
  assert.equal(unavailable.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(unavailable.headers['x-request-id'], 'gateway-downstream-request');
  const curlSmoke = spawnSync('bash', ['scripts/smoke-gateway.sh'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECT_DOWNSTREAM_FAILURE: 'true',
      GATEWAY_URL: address,
      SMOKE_CUSTOMER_TOKEN: customerToken,
    },
  });
  if (curlSmoke.status !== 0) {
    throw new Error(`Gateway curl smoke failed:\n${curlSmoke.stdout}\n${curlSmoke.stderr}`);
  }

  catalogServer = await startStub(catalogPort);
  await request(address).get('/api/events').expect(200);

  await closeServer(catalogServer);
  catalogServer = undefined;
  const cached = await request(address).get('/api/health').expect(200);
  assert.equal(cached.body.status, 'ok');
  await delay(5_100);
  const degraded = await request(address).get('/api/health').expect(200);
  assert.equal(degraded.body.status, 'degraded');
  assert.equal(degraded.body.gateway.status, 'up');
  assert.equal(degraded.body.downstreams.catalog, 'down');
  await request(address).get('/health/live').expect(200);
  console.log('Gateway e2e passed: auth, throttling, HTTP protections, downstream failures, and aggregated health.');
} catch (error) {
  console.error(gatewayOutput);
  throw error;
} finally {
  if (authServer) await closeServer(authServer);
  if (catalogServer) await closeServer(catalogServer);
  if (bookingServer) await closeServer(bookingServer);
  if (paymentServer) await closeServer(paymentServer);
  if (notificationServer) await closeServer(notificationServer);
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await new Promise((resolve) => gateway.once('exit', resolve));
  }
  await redis.flushdb();
  await redis.quit();
}

async function getUnusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  return address.port;
}

function startStub(port) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForGateway(url, process) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Gateway exited with ${process.exitCode}`);
    try {
      const response = await fetch(`${url}/health/live`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Gateway did not become ready within 10 seconds');
}