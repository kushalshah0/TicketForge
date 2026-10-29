import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { connect as connectAmqp } from 'amqplib';
import type { Channel } from 'amqplib';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDrizzle } from '@tf/common';
import { makeTestEvent, createPerTestDatabase, waitFor } from '@tf/testing';
import { runOnce, MessagingService } from '@tf/messaging';
import { OutboxRelay } from './outbox-relay';
import { writeOutbox } from './outbox.service';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integrationDescribe('OutboxRelay integration', () => {
  jest.setTimeout(60_000);

  const amqpUrl = process.env.AMQP_URL ?? 'amqp://guest:guest@127.0.0.1:5672';
  const postgresAdminUrl =
    process.env.TEST_POSTGRES_ADMIN_URL ??
    'postgresql://postgres:dev-password@127.0.0.1:5433/postgres';
  const queue = `outbox.integration.${randomUUID()}`;
  let adminPool: Pool;
  let testDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let databasePool: Pool;
  let database: ReturnType<typeof createDrizzle>;
  let messaging: MessagingService;
  let relay: OutboxRelay;
  let rabbitConnection: Awaited<ReturnType<typeof connectAmqp>>;
  let rabbitChannel: Channel;
  const received: Array<{
    content: Buffer;
    properties: { messageId?: string };
  }> = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: postgresAdminUrl });
    testDatabase = await createPerTestDatabase(adminPool);
    databasePool = new Pool({
      connectionString: testDatabase.connectionString,
    });
    database = createDrizzle(databasePool);
    await databasePool.query(`
      CREATE TABLE outbox (
        id bigserial PRIMARY KEY,
        message_id uuid NOT NULL UNIQUE,
        type text NOT NULL,
        payload jsonb NOT NULL,
        headers jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz NULL
      );
      CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
      CREATE TABLE processed_messages (
        message_id uuid NOT NULL,
        consumer text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (message_id, consumer)
      );
      CREATE TABLE business_rows (id uuid PRIMARY KEY);
      CREATE TABLE business_effects (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    `);

    messaging = new MessagingService();
    process.env.AMQP_URL = amqpUrl;
    await messaging.onModuleInit();
    relay = new OutboxRelay(createDrizzle(databasePool), messaging);

    rabbitConnection = await connectAmqp(amqpUrl);
    rabbitChannel = await rabbitConnection.createChannel();
    await rabbitChannel.assertExchange('tf.events', 'topic', { durable: true });
    await rabbitChannel.assertQueue(queue, {
      exclusive: true,
      autoDelete: true,
    });
    await rabbitChannel.bindQueue(queue, 'tf.events', 'user.registered');
    await rabbitChannel.consume(queue, (message) => {
      if (!message) return;
      received.push({
        content: message.content,
        properties: message.properties,
      });
      rabbitChannel.ack(message);
    });
  });

  afterAll(async () => {
    await rabbitChannel?.close();
    await rabbitConnection?.close();
    await messaging?.onModuleDestroy();
    await databasePool?.end();
    await testDatabase?.drop();
    await adminPool?.end();
  });

  it('publishes committed business/outbox rows after relay startup', async () => {
    const envelope = makeUserEvent('restart@example.test');
    await writeBusinessEvent(envelope);

    const beforeRelay = await databasePool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox WHERE message_id = $1',
      [envelope.id],
    );
    expect(beforeRelay.rows[0]?.published_at).toBeNull();

    await expect(relay.relayOnce()).resolves.toBe(1);
    await waitFor(() => Promise.resolve(received.length >= 1 ? true : false));
    const afterRelay = await databasePool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox WHERE message_id = $1',
      [envelope.id],
    );

    expect(afterRelay.rows[0]?.published_at).toBeInstanceOf(Date);
    expect(JSON.parse(received[0].content.toString())).toEqual(envelope);
  });

  it('leaves a row unpublished and counts a broker publish failure', async () => {
    const envelope = makeUserEvent('broker-failure@example.test');
    await writeBusinessEvent(envelope);
    const failuresBefore = (await relay.publishFailures.get()).values[0]?.value;
    const publishSpy = jest
      .spyOn(messaging, 'publish')
      .mockRejectedValueOnce(new Error('simulated broker outage'));

    await expect(relay.relayOnce()).rejects.toThrow('simulated broker outage');
    publishSpy.mockRestore();
    const result = await databasePool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox WHERE message_id = $1',
      [envelope.id],
    );
    const failures = await relay.publishFailures.get();

    expect(result.rows[0]?.published_at).toBeNull();
    expect(failures.values[0]?.value).toBe((failuresBefore ?? 0) + 1);
    await expect(relay.relayOnce()).resolves.toBe(1);
  });

  it('retries a publish after a simulated post-publish crash and processes the duplicate once', async () => {
    const envelope = makeUserEvent('crash@example.test');
    await writeBusinessEvent(envelope);
    const publish = messaging.publish.bind(messaging);
    const publishSpy = jest
      .spyOn(messaging, 'publish')
      .mockImplementationOnce(async (event, traceparent) => {
        await publish(event, traceparent);
        throw new Error('simulated crash before outbox commit');
      });

    await expect(relay.relayOnce()).rejects.toThrow(
      'simulated crash before outbox commit',
    );
    publishSpy.mockRestore();
    await waitFor(() => Promise.resolve(received.length >= 2 ? true : false));

    await expect(relay.relayOnce()).resolves.toBe(1);
    await waitFor(() => Promise.resolve(received.length >= 3 ? true : false));

    const duplicateMessages = received.filter(
      (message) => message.properties.messageId === envelope.id,
    );
    expect(duplicateMessages).toHaveLength(2);

    const processed = await database.transaction(async (client) => {
      const firstResult = await runOnce(
        client,
        envelope.id,
        'outbox-integration',
        async (transaction) => {
          await transaction.execute(
            sql`INSERT INTO business_effects DEFAULT VALUES`,
          );
        },
      );
      const duplicateResult = await runOnce(
        client,
        envelope.id,
        'outbox-integration',
        async (transaction) => {
          await transaction.execute(
            sql`INSERT INTO business_effects DEFAULT VALUES`,
          );
        },
      );
      return [firstResult, duplicateResult];
    });
    expect(processed).toEqual([true, false]);
    const effects = await databasePool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM business_effects',
    );
    expect(effects.rows[0]?.count).toBe('1');
  });

  it('does not publish the same row from two relays in parallel', async () => {
    const envelope = makeUserEvent('parallel@example.test');
    await writeBusinessEvent(envelope);
    const secondRelay = new OutboxRelay(database, messaging);

    const publishedCounts = await Promise.all([
      relay.relayOnce(),
      secondRelay.relayOnce(),
    ]);
    await waitFor(() =>
      Promise.resolve(
        received.some((message) => message.properties.messageId === envelope.id)
          ? true
          : false,
      ),
    );

    const matchingMessages = received.filter(
      (message) => message.properties.messageId === envelope.id,
    );
    expect(publishedCounts.reduce((total, count) => total + count, 0)).toBe(1);
    expect(matchingMessages).toHaveLength(1);
  });

  it('exports DB-time backlog age before publishing and clears it after recovery', async () => {
    const envelope = makeUserEvent('lag@example.test');
    await writeBusinessEvent(envelope);
    await databasePool.query(
      "UPDATE outbox SET created_at = now() - interval '45 seconds' WHERE message_id = $1",
      [envelope.id],
    );

    const before = await relay.oldestUnpublishedAge.get();
    expect(before.values[0].value).toBeGreaterThanOrEqual(45);

    await relay.relayOnce();
    const after = await relay.oldestUnpublishedAge.get();
    expect(after.values[0].value).toBe(0);
    const lag = await relay.lag.get();
    expect(lag.values.some((sample) => sample.labels.le === 30)).toBe(true);
    expect(lag.values.some((sample) => sample.labels.le === 60)).toBe(true);
  });

  it('starts only one polling timer and stops cleanly', async () => {
    const lifecycleRelay = new OutboxRelay(database, messaging);

    lifecycleRelay.onModuleInit();
    lifecycleRelay.start();
    await lifecycleRelay.onModuleDestroy();

    await expect(lifecycleRelay.relayOnce()).resolves.toBe(0);
  });

  async function writeBusinessEvent(
    envelope: ReturnType<typeof makeUserEvent>,
  ): Promise<void> {
    await database.transaction(async (client) => {
      await client.execute(
        sql`INSERT INTO business_rows (id) VALUES (${envelope.data.userId})`,
      );
      await writeOutbox(client, envelope, '00-integration-span-01');
    });
  }
});

function makeUserEvent(email: string) {
  return makeTestEvent('user.registered', {
    userId: randomUUID(),
    email,
    displayName: 'Outbox Test',
    role: 'customer',
  });
}
