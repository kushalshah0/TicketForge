import { createHmac, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from 'amqp-connection-manager';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createDrizzle, MetricsService } from '@tf/common';
import { parseEvent, routingKeys, type EventEnvelope } from '@tf/contracts';
import { createPerTestDatabase, makeTestEvent, waitFor } from '@tf/testing';
import { MessagingService } from '@tf/messaging';
import { EVENT_EXCHANGE } from '@tf/messaging';
import { OutboxRelay, OutboxService } from '@tf/outbox';
import { BookingService } from '../../booking/src/booking.service';
import {
  bookings as bookingRows,
  eventSnapshots,
  outbox as bookingOutbox,
  seats as bookingSeats,
} from '../../booking/src/database/schema';
import { BookingEventsConsumer } from './booking-events.consumer';
import { PAYMENT_PROVIDER, MockProvider } from './payment-provider';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentService } from './payment.service';
import type { PaymentProvider } from './payment-provider';
import {
  outbox as paymentOutbox,
  payments,
  processedMessages,
  refunds,
  webhookDeliveries,
} from './database/schema';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integrationDescribe('BookingEventsConsumer integration', () => {
  jest.setTimeout(60_000);

  const amqpUrl = process.env.AMQP_URL ?? 'amqp://guest:guest@127.0.0.1:5672';
  let adminPool: Pool;
  let testDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let bookingTestDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let databasePool: Pool;
  let database: ReturnType<typeof createDrizzle>;
  let bookingPool: Pool;
  let bookingDatabase: ReturnType<typeof createDrizzle>;
  let bookingService: BookingService;
  let outboxRelay: OutboxRelay;
  let webhookApp: INestApplication<App>;
  let handleWebhook: jest.Mock<PaymentService['handleWebhook']>;
  let intakePaymentId: string;
  let messaging: MessagingService;
  let publisher: ReturnType<typeof connect>;
  let publisherChannel: ReturnType<ReturnType<typeof connect>['createChannel']>;
  let integrationQueue: string;
  const metrics = new MetricsService();

  beforeAll(async () => {
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
      migrationsFolder: `${process.cwd()}/apps/payment/migrations`,
    });
    handleWebhook = jest
      .fn<PaymentService['handleWebhook']>()
      .mockResolvedValue(undefined);
    const webhookModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [
        {
          provide: PAYMENT_PROVIDER,
          useValue: new MockProvider(
            'payment-integration-test-secret',
            'http://127.0.0.1:3004/internal/webhooks/mock',
          ),
        },
        {
          provide: PaymentService,
          useValue: { handleWebhook },
        },
      ],
    }).compile();
    webhookApp = webhookModule.createNestApplication(new ExpressAdapter(), {
      rawBody: true,
    });
    await webhookApp.init();
    bookingTestDatabase = await createPerTestDatabase(adminPool);
    bookingPool = new Pool({
      connectionString: bookingTestDatabase.connectionString,
    });
    bookingDatabase = createDrizzle(bookingPool);
    await migrate(bookingDatabase, {
      migrationsFolder: `${process.cwd()}/apps/booking/migrations`,
    });

    process.env.AMQP_URL = amqpUrl;
    messaging = new MessagingService();
    await messaging.onModuleInit();
    publisher = connect([amqpUrl]);
    publisherChannel = publisher.createChannel({ confirm: true, json: false });
    await publisherChannel.waitForConnect();
    integrationQueue = `ticketforge.payment.integration.${randomUUID()}`;
    await publisherChannel.assertQueue(integrationQueue, { autoDelete: true });
    for (const type of [
      'booking.created',
      'booking.expired',
      'booking.cancelled',
      'refund.requested',
    ] as const) {
      await publisherChannel.bindQueue(
        integrationQueue,
        EVENT_EXCHANGE,
        routingKeys[type],
      );
    }
    await new BookingEventsConsumer(
      messaging,
      database,
      new OutboxService(),
      metrics,
    ).onModuleInit(integrationQueue);
  });

  afterAll(async () => {
    await webhookApp?.close();
    await outboxRelay?.onModuleDestroy();
    if (bookingService) await bookingService.onModuleDestroy();
    else await bookingPool?.end();
    await messaging?.onModuleDestroy();
    if (publisherChannel && integrationQueue) {
      await publisherChannel.deleteQueue(integrationQueue);
    }
    await publisherChannel?.close();
    await publisher?.close();
    await databasePool?.end();
    if (adminPool && bookingTestDatabase) {
      await waitFor(
        async () => {
          const result = await adminPool.query<{ remaining: number }>(
            'SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1',
            [bookingTestDatabase.name],
          );
          return result.rows[0]?.remaining === 0;
        },
        5_000,
        50,
      );
    }
    await bookingTestDatabase?.drop();
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
  });

  it('creates one pending payment when booking.created is redelivered', async () => {
    const eventId = randomUUID();
    const userId = randomUUID();
    await bookingDatabase.insert(eventSnapshots).values({
      eventId,
      organizerId: randomUUID(),
      title: 'Payment intake integration event',
      startsAt: new Date(Date.now() + 86_400_000),
      status: 'PUBLISHED',
      currency: 'NPR',
    });
    await bookingDatabase.insert(bookingSeats).values({
      eventId,
      seatId: 'A1',
      sectionId: 'A',
      tierId: 'standard',
      priceMinor: 4_321,
    });
    bookingService = new BookingService(
      bookingPool,
      bookingDatabase,
      new OutboxService(),
    );
    await bookingService.createHold(userId, 'payment-intake', {
      eventId,
      seatIds: ['A1'],
    });
    const [booking] = await bookingDatabase
      .select()
      .from(bookingRows)
      .where(
        and(eq(bookingRows.userId, userId), eq(bookingRows.eventId, eventId)),
      );
    if (!booking) throw new Error('Booking creation returned no row');
    const [bookingEvent] = await bookingDatabase
      .select()
      .from(bookingOutbox)
      .where(eq(bookingOutbox.type, 'booking.created'));
    if (!bookingEvent)
      throw new Error('Booking creation wrote no booking.created outbox event');
    const envelope = parseEvent('booking.created', bookingEvent.payload);
    if (envelope.type !== 'booking.created')
      throw new Error('Outbox event has the wrong type');

    outboxRelay = new OutboxRelay(bookingDatabase, messaging);
    await outboxRelay.relayOnce();
    const payment = await waitFor(async () => {
      const [row] = await database
        .select()
        .from(payments)
        .where(eq(payments.bookingId, booking.id));
      return row ?? false;
    });
    intakePaymentId = payment.id;

    await messaging.publish(envelope);
    await waitFor(async () => {
      const metrics = await messaging.processedCount.get();
      const duplicateCount = metrics.values.find(
        (metric) =>
          metric.labels.queue === integrationQueue &&
          metric.labels.result === 'duplicate',
      )?.value;
      return duplicateCount && duplicateCount > 0 ? duplicateCount : false;
    });

    const redelivery = makeTestEvent('booking.created', {
      ...envelope.data,
    });
    await publish(redelivery);
    await waitFor(async () => {
      const rows = await database
        .select()
        .from(processedMessages)
        .where(eq(processedMessages.consumer, 'payment.booking-events'));
      return rows.length === 2 ? rows : false;
    });

    const paymentsForBooking = await database
      .select()
      .from(payments)
      .where(eq(payments.bookingId, booking.id));
    const [publishedBookingEvent] = await bookingDatabase
      .select()
      .from(bookingOutbox)
      .where(eq(bookingOutbox.messageId, envelope.id));
    const data = envelope.data;
    expect(payment).toMatchObject({
      bookingId: booking.id,
      userId,
      amountMinor: 4_321,
      currency: 'NPR',
      status: 'PENDING',
      expiresAt: new Date(data.expiresAt),
    });
    expect(paymentsForBooking).toHaveLength(1);
    expect(publishedBookingEvent?.publishedAt).toBeInstanceOf(Date);
  });

  it('cancels pending payments on booking outcomes and refunds a payment only once', async () => {
    const expiredBookingId = randomUUID();
    const cancelledBookingId = randomUUID();
    const userId = randomUUID();
    const eventId = randomUUID();
    const expiredPaymentId = randomUUID();
    const cancelledPaymentId = randomUUID();
    await database.insert(payments).values([
      {
        id: expiredPaymentId,
        bookingId: expiredBookingId,
        userId,
        amountMinor: 2_500,
        currency: 'NPR',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: cancelledPaymentId,
        bookingId: cancelledBookingId,
        userId,
        amountMinor: 1_500,
        currency: 'NPR',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await publish(
      makeTestEvent('booking.expired', {
        bookingId: expiredBookingId,
        userId,
        eventId,
      }),
    );
    await publish(
      makeTestEvent('booking.cancelled', {
        bookingId: cancelledBookingId,
        userId,
        eventId,
        reason: 'USER_CANCELLED',
      }),
    );

    await waitFor(async () => {
      const rows = await database.select().from(payments);
      return rows.find((row) => row.id === expiredPaymentId)?.status ===
        'CANCELLED' &&
        rows.find((row) => row.id === cancelledPaymentId)?.status ===
          'CANCELLED'
        ? rows
        : false;
    });

    const refundedPaymentId = randomUUID();
    const refundedBookingId = randomUUID();
    await database.insert(payments).values({
      id: refundedPaymentId,
      bookingId: refundedBookingId,
      userId,
      amountMinor: 4_200,
      currency: 'NPR',
      status: 'SUCCEEDED',
      providerRef: `mock:${refundedPaymentId}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const refundRequest = makeTestEvent('refund.requested', {
      bookingId: refundedBookingId,
      paymentRef: refundedPaymentId,
      reason: 'LATE_PAYMENT',
    });
    await publish(refundRequest);
    await publish(refundRequest);
    await waitFor(async () => {
      const [payment] = await database
        .select()
        .from(payments)
        .where(eq(payments.id, refundedPaymentId));
      return payment?.status === 'REFUNDED' ? payment : false;
    });

    const matchingRefunds = await database
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, refundedPaymentId));
    const refundEvents = await databasePool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox
       WHERE type = 'payment.refunded' AND payload->'data'->>'paymentId' = $1`,
      [refundedPaymentId],
    );
    expect(matchingRefunds).toHaveLength(1);
    expect(matchingRefunds[0]).toMatchObject({
      amountMinor: 4_200,
      reason: 'LATE_PAYMENT',
      status: 'PENDING',
    });
    expect(refundEvents.rows[0]?.count).toBe(1);
    const refundMetric = await metrics.registry
      .getSingleMetric('payment_refunds')
      ?.get();
    expect(refundMetric?.values[0].value).toBe(1);
  });

  it('rejects an invalid webhook signature without changing payment data', async () => {
    const beforePayments = await database.select().from(payments);
    const beforeDeliveries = await database.select().from(webhookDeliveries);

    await request(webhookApp.getHttpServer())
      .post('/internal/webhooks/mock')
      .set('x-mock-signature', `sha256=${'0'.repeat(64)}`)
      .send({
        providerEventId: randomUUID(),
        paymentId: randomUUID(),
        bookingId: randomUUID(),
        outcome: 'succeeded',
        providerRef: 'mock:invalid',
      })
      .expect(401);

    expect(await database.select().from(payments)).toEqual(beforePayments);
    expect(await database.select().from(webhookDeliveries)).toEqual(
      beforeDeliveries,
    );
  });

  it('limits payment reads to the owner and starts one charge per idempotency key', async () => {
    const [payment] = await database.select().from(payments).limit(1);
    if (!payment) throw new Error('Payment intake test created no payment');
    const createCharge = jest.fn(() => Promise.resolve());
    const provider: PaymentProvider = {
      createCharge,
      verifyWebhook: () => true,
    };
    const service = new PaymentService(
      databasePool,
      database,
      provider,
      new OutboxService(),
    );
    const previousDemoMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';

    try {
      await expect(
        service.getPaymentByBooking(payment.userId, payment.bookingId),
      ).resolves.toMatchObject({
        id: payment.id,
      });
      await expect(
        service.getPaymentByBooking(randomUUID(), payment.bookingId),
      ).rejects.toMatchObject({
        status: 404,
      });

      const [first, replay] = await Promise.all([
        service.pay(payment.userId, payment.id, 'pay-once', {
          scenario: 'success',
        }),
        service.pay(payment.userId, payment.id, 'pay-once', {
          scenario: 'success',
        }),
      ]);
      expect(first).toEqual(replay);
      expect(first).toEqual({ paymentId: payment.id, status: 'PENDING' });
      expect(createCharge).toHaveBeenCalledTimes(1);
      await expect(
        service.pay(payment.userId, payment.id, 'second-key', {
          scenario: 'success',
        }),
      ).rejects.toMatchObject({
        code: 'PAYMENT_ALREADY_INITIATED',
        status: 409,
      });

      await expect(
        service.pay(payment.userId, payment.id, 'pay-once', {
          scenario: 'fail',
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });

      process.env.DEMO_MODE = 'false';
      await expect(
        service.pay(payment.userId, payment.id, 'demo-disabled', {
          scenario: 'success',
        }),
      ).rejects.toMatchObject({ code: 'DEMO_MODE_DISABLED', status: 403 });
      await expect(
        service.pay(payment.userId, payment.id, 'live-unavailable', {}),
      ).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        status: 503,
      });
      process.env.DEMO_MODE = 'true';

      const expiredPaymentId = randomUUID();
      await database.insert(payments).values({
        id: expiredPaymentId,
        bookingId: randomUUID(),
        userId: payment.userId,
        amountMinor: 1_000,
        currency: 'NPR',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 1_000),
      });
      await expect(
        service.pay(payment.userId, expiredPaymentId, 'expired-payment', {
          scenario: 'success',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_EXPIRED', status: 409 });
      expect(createCharge).toHaveBeenCalledTimes(1);
    } finally {
      if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previousDemoMode;
    }
  });

  it('forwards each verified webhook payload to the payment service', async () => {
    const [payment] = await database.select().from(payments).limit(1);
    if (!payment) throw new Error('Payment intake test created no payment');
    const payload = {
      providerEventId: randomUUID(),
      paymentId: payment.id,
      bookingId: payment.bookingId,
      outcome: 'succeeded',
      providerRef: `mock:${payment.id}`,
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac(
      'sha256',
      'payment-integration-test-secret',
    )
      .update(body)
      .digest('hex')}`;

    for (let delivery = 0; delivery < 2; delivery += 1) {
      await request(webhookApp.getHttpServer())
        .post('/internal/webhooks/mock')
        .set('x-mock-signature', signature)
        .set('content-type', 'application/json')
        .send(body)
        .expect(202);
    }

    expect(handleWebhook).toHaveBeenCalledTimes(2);
    expect(handleWebhook).toHaveBeenNthCalledWith(1, payload);
    expect(handleWebhook).toHaveBeenNthCalledWith(2, payload);
  });

  it('applies a verified success once and writes one payment outcome event', async () => {
    const [payment] = await database
      .select()
      .from(payments)
      .where(eq(payments.id, intakePaymentId));
    if (!payment) throw new Error('Payment intake test created no payment');
    const service = new PaymentService(
      databasePool,
      database,
      new MockProvider(
        'payment-integration-test-secret',
        'http://127.0.0.1:3004/internal/webhooks/mock',
      ),
      new OutboxService(),
    );
    const payload = {
      providerEventId: randomUUID(),
      paymentId: payment.id,
      bookingId: payment.bookingId,
      outcome: 'succeeded',
      providerRef: `mock:${payment.id}`,
    };
    await service.handleWebhook(payload);
    await service.handleWebhook(payload);

    const [updated] = await database
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id));
    const successEvents = await database
      .select()
      .from(paymentOutbox)
      .where(eq(paymentOutbox.type, 'payment.succeeded'));
    const deliveries = await database
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.providerEventId, payload.providerEventId));
    expect(updated?.status).toBe('SUCCEEDED');
    expect(successEvents).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it('ignores and logs a success webhook after a payment has failed', async () => {
    const paymentId = randomUUID();
    const bookingId = randomUUID();
    const userId = randomUUID();
    await database.insert(payments).values({
      id: paymentId,
      bookingId,
      userId,
      amountMinor: 2_000,
      currency: 'NPR',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const service = new PaymentService(
      databasePool,
      database,
      new MockProvider(
        'payment-integration-test-secret',
        'http://127.0.0.1:3004/internal/webhooks/mock',
      ),
      new OutboxService(),
    );
    const failedPayload = {
      providerEventId: randomUUID(),
      paymentId,
      bookingId,
      outcome: 'failed',
      providerRef: `mock:${paymentId}`,
      reason: 'Mock payment failed',
    };
    await service.handleWebhook(failedPayload);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await service.handleWebhook({
        providerEventId: randomUUID(),
        paymentId,
        bookingId,
        outcome: 'succeeded',
        providerRef: `mock:${paymentId}`,
      });
      const [payment] = await database
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId));
      const events = await database
        .select()
        .from(paymentOutbox)
        .where(eq(paymentOutbox.type, 'payment.failed'));
      expect(payment?.status).toBe('FAILED');
      expect(events).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring succeeded webhook'),
      );
    } finally {
      warn.mockRestore();
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
});
