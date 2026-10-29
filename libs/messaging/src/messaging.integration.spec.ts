import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { jest } from '@jest/globals';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { connect } from 'amqp-connection-manager';
import { connect as connectAmqp } from 'amqplib';
import { createDrizzle } from '@tf/common';
import { createPerTestDatabase, makeTestEvent, waitFor } from '@tf/testing';
import { EVENT_EXCHANGE, RETRY_TIERS } from './topology';
import { MessagingService } from './messaging.service';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
const execFileAsync = promisify(execFile);

integrationDescribe('MessagingService integration', () => {
  jest.setTimeout(60_000);

  const amqpUrl = process.env.AMQP_URL ?? 'amqp://guest:guest@127.0.0.1:5672';
  const postgresAdminUrl =
    process.env.TEST_POSTGRES_ADMIN_URL ??
    'postgresql://postgres:dev-password@127.0.0.1:5433/postgres';
  let adminPool: Pool;
  let testDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let databasePool: Pool;
  let messaging: MessagingService;
  let publisher: ReturnType<typeof connect>;
  let publisherChannel: ReturnType<ReturnType<typeof connect>['createChannel']>;
  let integrationQueue: string;
  let handlerCalls = 0;
  let retryAttempts = 0;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: postgresAdminUrl });
    testDatabase = await createPerTestDatabase(adminPool);
    databasePool = new Pool({
      connectionString: testDatabase.connectionString,
    });
    await databasePool.query(`
      CREATE TABLE processed_messages (
        message_id uuid NOT NULL,
        consumer text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (message_id, consumer)
      )
    `);

    messaging = new MessagingService();
    process.env.AMQP_URL = amqpUrl;
    await messaging.onModuleInit();
    publisher = connect([amqpUrl]);
    publisherChannel = publisher.createChannel({ confirm: true, json: false });
    await publisherChannel.waitForConnect();
    integrationQueue = `ticketforge.messaging.integration.${randomUUID()}`;
    await publisherChannel.assertQueue(integrationQueue, { autoDelete: true });
    await publisherChannel.bindQueue(
      integrationQueue,
      EVENT_EXCHANGE,
      'user.registered',
    );
    await publisherChannel.assertQueue(`${integrationQueue}.dlq`, {
      durable: true,
    });
    for (const tier of RETRY_TIERS) {
      await publisherChannel.assertQueue(
        `${integrationQueue}.retry.${tier.name}`,
        {
          durable: true,
          arguments: {
            'x-message-ttl': tier.ttl,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': integrationQueue,
          },
        },
      );
    }

    await messaging.consume(
      integrationQueue,
      (envelope) => {
        if (envelope.type !== 'user.registered') return Promise.resolve();
        if (envelope.data.displayName === 'retry-twice') {
          retryAttempts += 1;
          if (retryAttempts <= 2) throw new Error('temporary failure');
        }
        if (envelope.data.displayName === 'always-fails') {
          throw new Error('permanent failure');
        }
        handlerCalls += 1;
        return Promise.resolve();
      },
      {
        database: createDrizzle(databasePool),
        consumer: 'notification-integration',
      },
    );
  });

  afterAll(async () => {
    await messaging?.onModuleDestroy();
    if (publisherChannel && integrationQueue) {
      try {
        await publisherChannel.deleteQueue(integrationQueue);
        await publisherChannel.deleteQueue(`${integrationQueue}.dlq`);
        for (const tier of RETRY_TIERS) {
          await publisherChannel.deleteQueue(
            `${integrationQueue}.retry.${tier.name}`,
          );
        }
      } catch {
        await publisherChannel.close().catch(() => undefined);
      }
    }
    await publisherChannel?.close();
    await publisher?.close();
    await databasePool?.end();
    await testDatabase?.drop();
    await adminPool?.end();
  });

  it('processes once, retries twice, and routes poison/permanent failures to the DLQ', async () => {
    const duplicateEnvelope = makeTestEvent('user.registered', {
      userId: randomUUID(),
      email: 'duplicate@example.test',
      displayName: 'duplicate',
      role: 'customer',
    });
    await messaging.publish(duplicateEnvelope);
    await waitFor(() => Promise.resolve(handlerCalls === 1 ? true : false));
    await waitFor(async () => {
      const result = await databasePool.query(
        'SELECT 1 FROM processed_messages WHERE message_id = $1 AND consumer = $2',
        [duplicateEnvelope.id, 'notification-integration'],
      );
      return result.rowCount === 1 ? true : false;
    });
    await messaging.publish(duplicateEnvelope);
    try {
      await waitFor(() =>
        counterValue(messaging.processedCount, 'result', 'duplicate'),
      );
    } catch (error) {
      const metrics = {
        processed: await messaging.processedCount.get(),
        retries: await messaging.retries.get(),
        deadLetters: await messaging.deadLetters.get(),
      };
      throw new Error(
        `Duplicate message was not acknowledged: ${JSON.stringify(metrics)}`,
        {
          cause: error,
        },
      );
    }
    expect(handlerCalls).toBe(1);

    const retryEnvelope = makeTestEvent('user.registered', {
      userId: randomUUID(),
      email: 'retry@example.test',
      displayName: 'retry-twice',
      role: 'customer',
    });
    await messaging.publish(retryEnvelope);
    await waitFor(
      () => Promise.resolve(retryAttempts === 3 ? true : false),
      45_000,
      100,
    );
    expect(handlerCalls).toBe(2);

    await publisherChannel.publish(
      EVENT_EXCHANGE,
      'user.registered',
      Buffer.from('{invalid-json'),
      { persistent: true, messageId: randomUUID(), type: 'user.registered' },
    );
    await waitFor(() =>
      counterValue(messaging.deadLetters, 'reason', 'invalid_payload'),
    );

    const failedEnvelope = makeTestEvent('user.registered', {
      userId: randomUUID(),
      email: 'failed@example.test',
      displayName: 'always-fails',
      role: 'customer',
    });
    await publisherChannel.publish(
      EVENT_EXCHANGE,
      'user.registered',
      Buffer.from(JSON.stringify(failedEnvelope)),
      {
        persistent: true,
        messageId: failedEnvelope.id,
        type: failedEnvelope.type,
        headers: {
          'x-attempt': 2,
          'x-correlation-id': failedEnvelope.correlationId,
        },
      },
    );
    await waitFor(() =>
      counterValue(messaging.deadLetters, 'reason', 'handler_failed'),
    );
  });

  it('replays a DLQ message and resets its retry metadata', async () => {
    const replayQueue = `ticketforge.messaging.replay.${randomUUID()}`;
    const deadLetterQueue = `${replayQueue}.dlq`;
    const connection = await connectAmqp(amqpUrl);
    const channel = await connection.createConfirmChannel();

    try {
      await channel.assertQueue(replayQueue, { autoDelete: true });
      await channel.assertQueue(deadLetterQueue, { durable: true });

      const envelope = makeTestEvent('user.registered', {
        userId: randomUUID(),
        email: 'replay@example.test',
        displayName: 'replay',
        role: 'customer',
      });
      channel.sendToQueue(
        deadLetterQueue,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          messageId: envelope.id,
          type: envelope.type,
          headers: {
            'x-attempt': 2,
            'x-dlq-reason': 'handler_failed',
            'x-correlation-id': envelope.correlationId,
          },
        },
      );
      await channel.waitForConfirms();

      const { stdout } = await execFileAsync(
        process.execPath,
        ['scripts/dlq-replay.mjs', replayQueue],
        {
          cwd: process.cwd(),
          env: { ...process.env, AMQP_URL: amqpUrl },
          timeout: 15_000,
        },
      );
      expect(stdout).toContain(
        `Replayed 1 message(s) from ${deadLetterQueue} to ${replayQueue}.`,
      );

      const replayed = await channel.get(replayQueue, { noAck: false });
      if (!replayed)
        throw new Error(
          'The replayed message was not found in the main queue.',
        );
      expect(JSON.parse(replayed.content.toString())).toEqual(envelope);
      expect(replayed.properties.headers).toMatchObject({
        'x-attempt': 0,
        'x-correlation-id': envelope.correlationId,
      });
      expect(replayed.properties.headers).not.toHaveProperty('x-dlq-reason');
      channel.ack(replayed);
    } finally {
      try {
        await channel.deleteQueue(replayQueue);
        await channel.deleteQueue(deadLetterQueue);
      } finally {
        try {
          await channel.close();
        } finally {
          await connection.close();
        }
      }
    }
  });

  async function counterValue(
    counter: InstanceType<typeof import('prom-client').Counter>,
    label: 'result' | 'reason',
    value: string,
  ): Promise<number | false> {
    const snapshot = await counter.get();
    const metric = snapshot.values.find(
      (metricValue) =>
        metricValue.labels.queue === integrationQueue &&
        metricValue.labels[label] === value,
    );
    return metric?.value || false;
  }
});
