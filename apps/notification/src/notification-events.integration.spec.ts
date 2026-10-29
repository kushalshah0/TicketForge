import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { jest } from '@jest/globals';
import { promisify } from 'node:util';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from 'amqp-connection-manager';
import { Pool } from 'pg';
import { createDrizzle } from '@tf/common';
import { makeTestEvent, createPerTestDatabase, waitFor } from '@tf/testing';
import { EVENT_EXCHANGE, MessagingService, RETRY_TIERS } from '@tf/messaging';
import { routingKeys, type EventEnvelope } from '@tf/contracts';
import { notifications, recipients } from './database/schema';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { NotificationService } from './notification.service';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
const execFileAsync = promisify(execFile);

integrationDescribe('NotificationEventsConsumer integration', () => {
  jest.setTimeout(90_000);

  let adminPool: Pool;
  let testDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let databasePool: Pool;
  let database: ReturnType<typeof createDrizzle>;
  let messaging: MessagingService;
  let notificationService: NotificationService;
  let notificationConsumer: NotificationEventsConsumer;
  let publisher: ReturnType<typeof connect>;
  let publisherChannel: ReturnType<ReturnType<typeof connect>['createChannel']>;
  let integrationQueue: string;
  let previousAmqpUrl: string | undefined;
  let previousSmtpUrl: string | undefined;

  beforeAll(async () => {
    const amqpUrl = process.env.AMQP_URL ?? 'amqp://localhost:5672';
    previousAmqpUrl = process.env.AMQP_URL;
    previousSmtpUrl = process.env.SMTP_URL;
    process.env.SMTP_URL ??= 'smtp://127.0.0.1:1025';
    adminPool = new Pool({
      connectionString:
        process.env.TEST_POSTGRES_ADMIN_URL ??
        'postgres://postgres:dev-password@127.0.0.1:5433/postgres',
    });
    testDatabase = await createPerTestDatabase(adminPool);
    databasePool = new Pool({
      connectionString: testDatabase.connectionString,
    });
    database = createDrizzle(databasePool);
    await migrate(database, {
      migrationsFolder: `${process.cwd()}/apps/notification/migrations`,
    });
    notificationService = new NotificationService(databasePool);

    process.env.AMQP_URL = amqpUrl;
    messaging = new MessagingService();
    await messaging.onModuleInit();
    publisher = connect([amqpUrl]);
    publisherChannel = publisher.createChannel({ confirm: true, json: false });
    await publisherChannel.waitForConnect();
    integrationQueue = `ticketforge.notification.integration.${randomUUID()}`;
    await publisherChannel.assertQueue(integrationQueue, { durable: false });
    for (const type of [
      'user.registered',
      'booking.confirmed',
      'booking.cancelled',
      'booking.expired',
      'payment.refunded',
    ] as const) {
      await publisherChannel.bindQueue(
        integrationQueue,
        EVENT_EXCHANGE,
        routingKeys[type],
      );
    }
    notificationConsumer = new NotificationEventsConsumer(
      messaging,
      database,
      notificationService,
    );
    await notificationConsumer.onModuleInit(integrationQueue);
  });

  afterAll(async () => {
    await messaging?.onModuleDestroy();
    if (publisherChannel && integrationQueue) {
      await publisherChannel.deleteQueue(integrationQueue);
    }
    await publisherChannel?.close();
    await publisher?.close();
    if (notificationService) await notificationService.onModuleDestroy();
    else await databasePool?.end();
    if (adminPool && testDatabase) {
      await waitFor(
        async () => {
          const result = await adminPool.query<{ remaining: number }>(
            'SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1',
            [testDatabase.name],
          );
          return result.rows[0]?.remaining === 0;
        },
        5_000,
        50,
      );
    }
    await testDatabase?.drop();
    await adminPool?.end();
    if (previousAmqpUrl === undefined) delete process.env.AMQP_URL;
    else process.env.AMQP_URL = previousAmqpUrl;
    if (previousSmtpUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = previousSmtpUrl;
  });

  it('stores one recipient for duplicate and redelivered registration events', async () => {
    const userId = randomUUID();
    const registration = makeTestEvent('user.registered', {
      userId,
      email: 'recipient@example.test',
      displayName: 'Test Recipient',
      role: 'customer',
    });

    await publish(registration);

    await waitFor(async () => {
      const rows = await database.select().from(recipients);
      return rows.length === 1 ? rows : false;
    });
    await publish(registration);
    await waitFor(async () => {
      const metrics = await messaging.processedCount.get();
      const duplicateCount = metrics.values.find(
        (metric) =>
          metric.labels.queue === integrationQueue &&
          metric.labels.result === 'duplicate',
      )?.value;
      return duplicateCount && duplicateCount > 0 ? duplicateCount : false;
    });
    await publish(
      makeTestEvent('user.registered', {
        userId,
        email: 'recipient@example.test',
        displayName: 'Test Recipient',
        role: 'customer',
      }),
    );

    await waitFor(async () => {
      const metrics = await messaging.processedCount.get();
      const processedCount = metrics.values.find(
        (metric) =>
          metric.labels.queue === integrationQueue &&
          metric.labels.result === 'processed',
      )?.value;
      return processedCount && processedCount > 1 ? processedCount : false;
    });

    const storedRecipients = await database.select().from(recipients);
    expect(storedRecipients).toHaveLength(1);
    expect(storedRecipients[0]).toMatchObject({
      userId,
      email: 'recipient@example.test',
      displayName: 'Test Recipient',
      role: 'customer',
    });
  });

  it('rejects invalid recipient roles and notification delivery states', async () => {
    await expect(
      databasePool.query(
        `INSERT INTO recipients (user_id, email, display_name, role)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), 'invalid-role@example.test', 'Invalid Role', 'admin'],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const userId = randomUUID();
    await database.insert(recipients).values({
      userId,
      email: 'invalid-status@example.test',
      displayName: 'Invalid Status',
      role: 'customer',
    });

    await expect(
      databasePool.query(
        `INSERT INTO notifications (user_id, type, source_event_id, status)
         VALUES ($1, $2, $3, $4)`,
        [userId, 'booking.cancelled', randomUUID(), 'FAILED'],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      databasePool.query(
        `INSERT INTO notifications (user_id, type, source_event_id, status)
         VALUES ($1, $2, $3, $4)`,
        [userId, 'booking.cancelled', randomUUID(), 'SENT'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('sends one confirmation email with inline QR tickets', async () => {
    const userId = randomUUID();
    const eventTitle = `Integration Night ${randomUUID()}`;
    await publish(
      makeTestEvent('user.registered', {
        userId,
        email: 'ticket-recipient@example.test',
        displayName: 'Ticket Recipient',
        role: 'customer',
      }),
    );
    await waitFor(async () => {
      const [recipient] = await database
        .select()
        .from(recipients)
        .where(eq(recipients.userId, userId));
      return recipient?.userId === userId ? recipient : false;
    });
    const confirmation = makeTestEvent('booking.confirmed', {
      bookingId: randomUUID(),
      userId,
      eventTitle,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      totalMinor: 4_321,
      currency: 'JPY',
      tickets: [
        {
          ticketId: randomUUID(),
          seatId: 'A1',
          qrToken: `ticket-${randomUUID()}`,
        },
      ],
    });
    await publish(confirmation);

    const notification = await waitFor(async () => {
      const [row] = await database
        .select()
        .from(notifications)
        .where(eq(notifications.sourceEventId, confirmation.id));
      return row?.status === 'SENT' ? row : false;
    });
    expect(notification.subject).toBe(`Your tickets for ${eventTitle}`);
    expect(notification.body).toContain('¥4,321');
    expect(notification.body).toContain('QR code included in the HTML email');
    expect(notification.body).not.toContain(
      confirmation.data.tickets[0]?.qrToken,
    );

    const mailpitApiUrl =
      process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025/api/v1';
    const messagesResponse = await fetch(`${mailpitApiUrl}/messages`);
    expect(messagesResponse.ok).toBe(true);
    const messages = (await messagesResponse.json()) as {
      messages: Array<{ ID: string; Subject: string }>;
    };
    const delivered = messages.messages.find(
      (message) => message.Subject === notification.subject,
    );
    expect(delivered).toBeDefined();
    if (!delivered)
      throw new Error('Mailpit did not receive the confirmation email');

    const messageResponse = await fetch(
      `${mailpitApiUrl}/message/${delivered.ID}`,
    );
    expect(messageResponse.ok).toBe(true);
    const deliveredMessage = (await messageResponse.json()) as {
      Inline?: Array<{ ContentType: string; ContentID?: string }>;
      HTML?: string;
      Text?: string;
    };
    expect(deliveredMessage.HTML).toContain('cid:ticket-');
    expect(deliveredMessage.Inline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ContentType: 'image/png' }),
      ]),
    );
    expect(deliveredMessage.Text).toContain('Seat A1');

    const metricsBeforeReplay = await messaging.processedCount.get();
    const duplicatesBeforeReplay =
      metricsBeforeReplay.values.find(
        (metric) =>
          metric.labels.queue === integrationQueue &&
          metric.labels.result === 'duplicate',
      )?.value ?? 0;
    await publish(confirmation);
    await waitFor(async () => {
      const metrics = await messaging.processedCount.get();
      const duplicateCount = metrics.values.find(
        (metric) =>
          metric.labels.queue === integrationQueue &&
          metric.labels.result === 'duplicate',
      )?.value;
      return duplicateCount && duplicateCount > duplicatesBeforeReplay
        ? duplicateCount
        : false;
    });
    const repeatedNotifications = await database
      .select()
      .from(notifications)
      .where(eq(notifications.sourceEventId, confirmation.id));
    expect(repeatedNotifications).toHaveLength(1);

    const refunded = makeTestEvent('payment.refunded', {
      paymentId: randomUUID(),
      bookingId: randomUUID(),
      userId,
      amountMinor: 4_200,
      currency: 'NPR',
      reason: 'EVENT_CANCELLED',
    });
    await publish(refunded);
    const refundNotification = await waitFor(async () => {
      const [row] = await database
        .select()
        .from(notifications)
        .where(eq(notifications.sourceEventId, refunded.id));
      return row?.status === 'SENT' ? row : false;
    });
    expect(refundNotification.body).toContain(
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: 'NPR',
      }).format(42),
    );

    const cancelled = makeTestEvent('booking.cancelled', {
      bookingId: randomUUID(),
      userId,
      eventId: randomUUID(),
      reason: 'EVENT_CANCELLED',
    });
    const expired = makeTestEvent('booking.expired', {
      bookingId: randomUUID(),
      userId,
      eventId: randomUUID(),
    });
    await publish(cancelled);
    await publish(expired);
    const terminalNotifications = await waitFor(async () => {
      const rows = await database
        .select()
        .from(notifications)
        .where(
          inArray(notifications.sourceEventId, [cancelled.id, expired.id]),
        );
      return rows.length === 2 && rows.every((row) => row.status === 'SENT')
        ? rows
        : false;
    });
    expect(terminalNotifications.map((row) => row.body)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('EVENT_CANCELLED'),
        expect.stringContaining('expired before payment was completed'),
      ]),
    );
  });

  it('recovers after an SMTP outage, dead-letters persistent failures, and replays them', async () => {
    const retryQueue = `ticketforge.notification.smtp.integration.${randomUUID()}`;
    const retryDlq = `${retryQueue}.dlq`;
    const smtp = await createRecoverableSmtpServer();
    const smtpPool = new Pool({
      connectionString: testDatabase.connectionString,
    });
    const smtpService = new NotificationService(smtpPool);
    const smtpConsumer = new NotificationEventsConsumer(
      messaging,
      database,
      smtpService,
    );
    const previousSmtpUrl = process.env.SMTP_URL;

    try {
      process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.port}`;
      await publisherChannel.assertQueue(retryQueue, { durable: true });
      await publisherChannel.assertQueue(retryDlq, { durable: true });
      for (const tier of RETRY_TIERS) {
        await publisherChannel.assertQueue(`${retryQueue}.retry.${tier.name}`, {
          durable: true,
          arguments: {
            'x-message-ttl': tier.ttl,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': retryQueue,
          },
        });
      }
      await smtpConsumer.onModuleInit(retryQueue);
      await waitFor(async () => {
        const queueState = await publisherChannel.checkQueue(retryQueue);
        return queueState.consumerCount > 0 ? queueState : false;
      });

      const userId = randomUUID();
      await database.insert(recipients).values({
        userId,
        email: 'smtp-retry@example.test',
        displayName: 'SMTP Retry',
        role: 'customer',
      });

      const retryBeforeRecovery = await queueCounter(
        messaging.retries,
        retryQueue,
      );
      const recoveredEvent = makeTestEvent('booking.cancelled', {
        bookingId: randomUUID(),
        userId,
        eventId: randomUUID(),
        reason: 'USER_CANCELLED',
      });
      await publishToQueue(retryQueue, recoveredEvent);
      await waitFor(
        async () =>
          (await queueCounter(messaging.retries, retryQueue)) >
          retryBeforeRecovery,
        10_000,
        50,
      );
      await smtp.setAvailable(true);
      await smtpService.sendMail({
        to: 'smtp-probe@example.test',
        subject: 'SMTP fixture readiness',
        text: 'SMTP is accepting messages.',
      });
      const recoveredNotification = await waitFor(
        async () => {
          const [row] = await database
            .select()
            .from(notifications)
            .where(eq(notifications.sourceEventId, recoveredEvent.id));
          return row?.status === 'SENT' ? row : false;
        },
        15_000,
        50,
      );
      expect(recoveredNotification.body).toContain(
        'Your booking has been cancelled',
      );
      expect(
        smtp.messages.some((message) =>
          message.includes('smtp-retry@example.test'),
        ),
      ).toBe(true);

      await smtp.setAvailable(false);
      const failedEvent = makeTestEvent('booking.cancelled', {
        bookingId: randomUUID(),
        userId,
        eventId: randomUUID(),
        reason: 'EVENT_CANCELLED',
      });
      const retryBeforeFailure = await queueCounter(
        messaging.retries,
        retryQueue,
      );
      const deadLettersBeforeFailure = await queueCounter(
        messaging.deadLetters,
        retryQueue,
        'handler_failed',
      );
      await publishToQueue(retryQueue, failedEvent);
      await waitFor(
        async () =>
          (await queueCounter(messaging.retries, retryQueue)) >
          retryBeforeFailure,
        15_000,
        100,
      );
      const firstRetryScheduledAt = Date.now();
      await waitFor(
        async () =>
          (await queueCounter(messaging.retries, retryQueue)) >
          retryBeforeFailure + 1,
        15_000,
        100,
      );
      const secondRetryScheduledAt = Date.now();
      expect(
        secondRetryScheduledAt - firstRetryScheduledAt,
      ).toBeGreaterThanOrEqual(4_000);
      await waitFor(
        async () =>
          (await queueCounter(
            messaging.deadLetters,
            retryQueue,
            'handler_failed',
          )) > deadLettersBeforeFailure,
        40_000,
        100,
      );
      expect(Date.now() - secondRetryScheduledAt).toBeGreaterThanOrEqual(
        24_000,
      );
      const deadLetterState = await publisherChannel.checkQueue(retryDlq);
      expect(deadLetterState.messageCount).toBe(1);

      const { stdout } = await execFileAsync(
        process.execPath,
        ['scripts/dlq-replay.mjs', retryQueue],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AMQP_URL: process.env.AMQP_URL ?? 'amqp://localhost:5672',
          },
          timeout: 15_000,
        },
      );
      expect(stdout).toContain(
        `Replayed 1 message(s) from ${retryDlq} to ${retryQueue}.`,
      );
      await smtp.setAvailable(true);
      const replayedNotification = await waitFor(
        async () => {
          const [row] = await database
            .select()
            .from(notifications)
            .where(eq(notifications.sourceEventId, failedEvent.id));
          return row?.status === 'SENT' ? row : false;
        },
        15_000,
        50,
      );
      expect(replayedNotification.body).toContain('EVENT_CANCELLED');
      expect(
        smtp.messages.some((message) => message.includes('EVENT_CANCELLED')),
      ).toBe(true);
      expect((await publisherChannel.checkQueue(retryDlq)).messageCount).toBe(
        0,
      );
    } finally {
      if (previousSmtpUrl === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = previousSmtpUrl;
      const cleanup = [
        () => smtpService.onModuleDestroy(),
        () => smtp.close(),
        () => publisherChannel.deleteQueue(retryQueue),
        () => publisherChannel.deleteQueue(retryDlq),
        ...RETRY_TIERS.map(
          (tier) => () =>
            publisherChannel.deleteQueue(`${retryQueue}.retry.${tier.name}`),
        ),
      ];
      const cleanupResults = await Promise.allSettled(
        cleanup.map((operation) => operation()),
      );
      const cleanupErrors: unknown[] = [];
      for (const result of cleanupResults) {
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'SMTP retry integration cleanup failed',
        );
      }
    }
  });

  async function publish(envelope: EventEnvelope): Promise<void> {
    await publisherChannel.publish(
      EVENT_EXCHANGE,
      routingKeys[envelope.type],
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.id,
        type: envelope.type,
      },
    );
  }

  async function publishToQueue(
    queue: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    await publisherChannel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.id,
        type: envelope.type,
        headers: {
          'x-attempt': 0,
          'x-correlation-id': envelope.correlationId,
        },
      },
    );
  }

  async function queueCounter(
    counter: InstanceType<typeof import('prom-client').Counter>,
    queue: string,
    reason?: string,
  ): Promise<number> {
    const snapshot = await counter.get();
    return (
      snapshot.values.find(
        (metric) =>
          metric.labels.queue === queue &&
          (reason === undefined || metric.labels.reason === reason),
      )?.value ?? 0
    );
  }
});

async function createRecoverableSmtpServer(): Promise<{
  port: number;
  messages: string[];
  setAvailable(available: boolean): Promise<void>;
  close(): Promise<void>;
}> {
  let listening = true;
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    acceptSmtpMessage(socket, messages);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('SMTP test server has no TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  listening = false;

  async function setAvailable(available: boolean): Promise<void> {
    if (available === listening) return;
    if (available) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          listening = true;
          resolve();
        });
      });
      return;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else {
          listening = false;
          resolve();
        }
      });
    });
  }

  return {
    port,
    messages,
    setAvailable,
    close: () => setAvailable(false),
  };
}

function acceptSmtpMessage(socket: Socket, messages: string[]): void {
  let input = '';
  let inData = false;
  let message = '';
  socket.write('220 ticketforge.test ESMTP\r\n');

  socket.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    while (inData) {
      const terminator = input.indexOf('\r\n.\r\n');
      if (terminator < 0) {
        const retained = Math.min(input.length, 5);
        message += input.slice(0, input.length - retained);
        input = input.slice(input.length - retained);
        return;
      }
      message += input.slice(0, terminator);
      input = input.slice(terminator + 5);
      messages.push(message);
      message = '';
      inData = false;
      socket.write('250 Message accepted\r\n');
    }

    let lineEnd = input.indexOf('\r\n');
    while (lineEnd >= 0) {
      const line = input.slice(0, lineEnd);
      input = input.slice(lineEnd + 2);
      if (/^(EHLO|HELO)\b/i.test(line)) {
        socket.write('250-ticketforge.test\r\n250 SIZE 10485760\r\n');
      } else if (/^DATA$/i.test(line)) {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT$/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
      if (inData) break;
      lineEnd = input.indexOf('\r\n');
    }
  });
}
