import { randomUUID } from 'node:crypto';
import {
  createServer,
  connect as connectTcp,
  type Server,
  type Socket,
} from 'node:net';
import { jest } from '@jest/globals';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from 'amqp-connection-manager';
import { Pool } from 'pg';
import { createDrizzle } from '@tf/common';
import { parseEvent, routingKeys } from '@tf/contracts';
import { createPerTestDatabase, makeTestEvent, waitFor } from '@tf/testing';
import { MessagingService, EVENT_EXCHANGE } from '@tf/messaging';
import { OutboxRelay, OutboxService } from '@tf/outbox';
import { BookingService } from '../../booking/src/booking.service';
import { CatalogEventsConsumer } from '../../booking/src/catalog-events.consumer';
import { PaymentEventsConsumer } from '../../booking/src/payment-events.consumer';
import {
  bookings as bookingRows,
  eventSnapshots,
  outbox as bookingOutbox,
  seats as bookingSeats,
  tickets,
} from '../../booking/src/database/schema';
import { BookingEventsConsumer } from './booking-events.consumer';
import {
  outbox as paymentOutbox,
  payments,
  refunds,
  webhookDeliveries,
} from './database/schema';
import { PaymentService } from './payment.service';
import type { PaymentProvider } from './payment-provider';
import { NotificationEventsConsumer } from '../../notification/src/notification-events.consumer';
import {
  notifications,
  recipients,
} from '../../notification/src/database/schema';
import { NotificationService } from '../../notification/src/notification.service';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

type BrokerProxy = {
  url: string;
  setAvailable(available: boolean): void;
  close(): Promise<void>;
};

type SagaRuntime = {
  messaging: MessagingService;
  bookingRelay: OutboxRelay;
  paymentRelay: OutboxRelay;
  paymentEventsQueue: string;
  publisherChannel: ReturnType<ReturnType<typeof connect>['createChannel']>;
  startBookingPaymentConsumer(): Promise<void>;
  proxy?: BrokerProxy;
  close(): Promise<void>;
};

integrationDescribe('cross-service payment saga integration', () => {
  jest.setTimeout(90_000);

  const amqpUrl = process.env.AMQP_URL ?? 'amqp://localhost:5672';
  let adminPool: Pool;
  let paymentTestDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let bookingTestDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let notificationTestDatabase: Awaited<
    ReturnType<typeof createPerTestDatabase>
  >;
  let paymentPool: Pool;
  let paymentDatabase: ReturnType<typeof createDrizzle>;
  let bookingPool: Pool;
  let bookingDatabase: ReturnType<typeof createDrizzle>;
  let notificationPool: Pool;
  let notificationDatabase: ReturnType<typeof createDrizzle>;
  let bookingService: BookingService;
  let paymentService: PaymentService;
  let notificationService: NotificationService;
  let runtime: SagaRuntime | undefined;
  let previousQrSecret: string | undefined;
  let previousSmtpUrl: string | undefined;

  beforeAll(async () => {
    previousQrSecret = process.env.QR_SECRET;
    process.env.QR_SECRET = 'ticketforge-saga-integration-test-secret';
    previousSmtpUrl = process.env.SMTP_URL;
    process.env.SMTP_URL ??= 'smtp://127.0.0.1:1025';
    adminPool = new Pool({
      connectionString:
        process.env.TEST_POSTGRES_ADMIN_URL ??
        'postgres://postgres:dev-password@127.0.0.1:5433/postgres',
    });
    paymentTestDatabase = await createPerTestDatabase(adminPool);
    bookingTestDatabase = await createPerTestDatabase(adminPool);
    notificationTestDatabase = await createPerTestDatabase(adminPool);
    paymentPool = new Pool({
      connectionString: paymentTestDatabase.connectionString,
    });
    bookingPool = new Pool({
      connectionString: bookingTestDatabase.connectionString,
    });
    notificationPool = new Pool({
      connectionString: notificationTestDatabase.connectionString,
    });
    paymentDatabase = createDrizzle(paymentPool);
    bookingDatabase = createDrizzle(bookingPool);
    notificationDatabase = createDrizzle(notificationPool);
    await migrate(paymentDatabase, {
      migrationsFolder: `${process.cwd()}/apps/payment/migrations`,
    });
    await migrate(bookingDatabase, {
      migrationsFolder: `${process.cwd()}/apps/booking/migrations`,
    });
    await migrate(notificationDatabase, {
      migrationsFolder: `${process.cwd()}/apps/notification/migrations`,
    });
    bookingService = new BookingService(
      bookingPool,
      bookingDatabase,
      new OutboxService(),
    );
    notificationService = new NotificationService(notificationPool);
    const provider: PaymentProvider = {
      createCharge: () => Promise.resolve(),
      verifyWebhook: () => true,
    };
    paymentService = new PaymentService(
      paymentPool,
      paymentDatabase,
      provider,
      new OutboxService(),
    );
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  afterAll(async () => {
    await bookingService?.onModuleDestroy();
    await paymentService?.onModuleDestroy();
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
    if (adminPool && paymentTestDatabase) {
      await waitFor(
        async () => {
          const result = await adminPool.query<{ remaining: number }>(
            'SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1',
            [paymentTestDatabase.name],
          );
          return result.rows[0]?.remaining === 0;
        },
        5_000,
        50,
      );
    }
    await paymentTestDatabase?.drop();
    await notificationService?.onModuleDestroy();
    if (adminPool && notificationTestDatabase) {
      await waitFor(
        async () => {
          const result = await adminPool.query<{ remaining: number }>(
            'SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1',
            [notificationTestDatabase.name],
          );
          return result.rows[0]?.remaining === 0;
        },
        5_000,
        50,
      );
    }
    await notificationTestDatabase?.drop();
    await adminPool?.end();
    if (previousQrSecret === undefined) delete process.env.QR_SECRET;
    else process.env.QR_SECRET = previousQrSecret;
    if (previousSmtpUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = previousSmtpUrl;
  });

  it('completes booking, payment, confirmation, and ticket issuance', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    await paymentService.handleWebhook(successWebhook(payment));
    await runtime.paymentRelay.relayOnce();

    const confirmed = await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CONFIRMED' ? row : false,
      ),
    );
    const issued = await bookingDatabase
      .select()
      .from(tickets)
      .where(eq(tickets.bookingId, booking.id));

    expect(confirmed.status).toBe('CONFIRMED');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.status).toBe('VALID');
    await expectCrossServiceAudit();
  });

  it('registers, books, pays, emails a ticket, and checks it in', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();

    const notificationQueue = `ticketforge.saga.integration.${randomUUID()}.notification`;
    await runtime.publisherChannel.assertQueue(notificationQueue, {
      durable: false,
      autoDelete: true,
    });
    for (const type of ['user.registered', 'booking.confirmed'] as const) {
      await runtime.publisherChannel.bindQueue(
        notificationQueue,
        EVENT_EXCHANGE,
        routingKeys[type],
      );
    }
    const notificationConsumer = new NotificationEventsConsumer(
      runtime.messaging,
      notificationDatabase,
      notificationService,
    );
    await notificationConsumer.onModuleInit(notificationQueue);

    const userId = randomUUID();
    const email = `customer-${randomUUID()}@example.test`;
    await runtime.messaging.publish(
      makeTestEvent('user.registered', {
        userId,
        email,
        displayName: 'End-to-end Customer',
        role: 'customer',
      }),
    );
    await waitFor(async () => {
      const [recipient] = await notificationDatabase
        .select()
        .from(recipients)
        .where(eq(recipients.userId, userId));
      return recipient ?? false;
    });

    const eventTitle = `End-to-end ${randomUUID()}`;
    const { booking, payment } = await createBookingAndPayment(
      runtime,
      userId,
      eventTitle,
    );
    await paymentService.handleWebhook(successWebhook(payment));
    await runtime.paymentRelay.relayOnce();
    await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CONFIRMED' ? row : false,
      ),
    );
    await runtime.bookingRelay.relayOnce();

    const notification = await waitFor(async () => {
      const [row] = await notificationDatabase
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.type, 'booking.confirmed'),
          ),
        );
      return row?.status === 'SENT' ? row : false;
    });
    expect(notification.body).toContain(eventTitle);
    expect(notification.body).toContain('Seat A1');

    const mailpitApiUrl =
      process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025/api/v1';
    const mailpitResponse = await fetch(`${mailpitApiUrl}/messages`);
    expect(mailpitResponse.ok).toBe(true);
    const mailpitMessages = (await mailpitResponse.json()) as {
      messages: Array<{ ID: string; Subject: string }>;
    };
    const delivered = mailpitMessages.messages.find(
      (message) => message.Subject === notification.subject,
    );
    expect(delivered).toBeDefined();
    if (!delivered)
      throw new Error(
        'Mailpit did not receive the end-to-end confirmation email',
      );
    const mailpitMessageResponse = await fetch(
      `${mailpitApiUrl}/message/${delivered.ID}`,
    );
    expect(mailpitMessageResponse.ok).toBe(true);
    const deliveredMessage = (await mailpitMessageResponse.json()) as {
      Inline?: Array<{ ContentType: string }>;
      HTML?: string;
    };
    expect(deliveredMessage.HTML).toContain('cid:ticket-');
    expect(deliveredMessage.Inline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ContentType: 'image/png' }),
      ]),
    );

    const [event] = await bookingDatabase
      .select({ organizerId: eventSnapshots.organizerId })
      .from(eventSnapshots)
      .where(eq(eventSnapshots.eventId, booking.eventId));
    if (!event) throw new Error('Ticket event snapshot was not found');
    const [confirmedEvent] = await bookingDatabase
      .select({ payload: bookingOutbox.payload })
      .from(bookingOutbox)
      .where(
        and(
          eq(bookingOutbox.type, 'booking.confirmed'),
          sql`${bookingOutbox.payload}->'data'->>'bookingId' = ${booking.id}`,
        ),
      )
      .limit(1);
    const confirmation = parseEvent(
      'booking.confirmed',
      confirmedEvent?.payload,
    );
    if (confirmation.type !== 'booking.confirmed') {
      throw new Error('Booking confirmation event was not published');
    }
    const scanned = await bookingService.checkIn(event.organizerId, {
      token: confirmation.data.tickets[0]?.qrToken,
    });
    expect(scanned).toMatchObject({
      id: confirmation.data.tickets[0]?.ticketId,
      status: 'USED',
    });
    await runtime.publisherChannel.deleteQueue(notificationQueue);
    await expectCrossServiceAudit();
  });

  it('cancels and releases a booking after payment failure', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    await paymentService.handleWebhook({
      providerEventId: randomUUID(),
      paymentId: payment.id,
      bookingId: booking.id,
      outcome: 'failed',
      providerRef: `mock:${payment.id}`,
      reason: 'Mock payment failed',
    });
    await runtime.paymentRelay.relayOnce();

    const cancelled = await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CANCELLED' ? row : false,
      ),
    );
    const [seat] = await bookingDatabase
      .select()
      .from(bookingSeats)
      .where(
        and(
          eq(bookingSeats.eventId, booking.eventId),
          eq(bookingSeats.seatId, 'A1'),
        ),
      );
    expect(cancelled.cancelReason).toBe('PAYMENT_FAILED');
    expect(seat).toMatchObject({
      status: 'AVAILABLE',
      bookingId: null,
      heldUntil: null,
    });
    await expectCrossServiceAudit();
  });

  it('refunds a late success after hold expiry', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    await bookingDatabase
      .update(bookingRows)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(bookingRows.id, booking.id));
    await expect(bookingService.sweepExpiredBookings()).resolves.toBe(1);

    await paymentService.handleWebhook(successWebhook(payment));
    await runtime.paymentRelay.relayOnce();
    await waitFor(async () => {
      const [event] = await bookingDatabase
        .select()
        .from(bookingOutbox)
        .where(
          and(
            eq(bookingOutbox.type, 'refund.requested'),
            sql`${bookingOutbox.payload}->'data'->>'bookingId' = ${booking.id}`,
          ),
        );
      return event ? event : false;
    });
    await runtime.bookingRelay.relayOnce();

    const refundedPayment = await waitFor(() =>
      paymentDatabase
        .select()
        .from(payments)
        .where(eq(payments.id, payment.id))
        .then(([row]) => (row?.status === 'REFUNDED' ? row : false)),
    );
    const matchingRefunds = await paymentDatabase
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, payment.id));
    expect(refundedPayment.status).toBe('REFUNDED');
    expect(matchingRefunds).toHaveLength(1);
    expect(matchingRefunds[0]?.reason).toBe('LATE_PAYMENT');
    await expectCrossServiceAudit();
  });

  it('ignores a duplicate payment.succeeded delivery', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    await paymentService.handleWebhook(successWebhook(payment));
    const [outboxRow] = await paymentDatabase
      .select()
      .from(paymentOutbox)
      .where(
        and(
          eq(paymentOutbox.type, 'payment.succeeded'),
          sql`${paymentOutbox.payload}->'data'->>'bookingId' = ${booking.id}`,
        ),
      );
    if (!outboxRow) throw new Error('Successful payment wrote no outbox event');
    const envelope = parseEvent('payment.succeeded', outboxRow.payload);
    if (envelope.type !== 'payment.succeeded')
      throw new Error('Incorrect payment outcome event type');

    await runtime.paymentRelay.relayOnce();
    await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CONFIRMED' ? row : false,
      ),
    );
    await runtime.messaging.publish(envelope);
    await waitFor(async () => {
      const metrics = await runtime?.messaging.processedCount.get();
      const duplicateCount = metrics?.values.find(
        (metric) =>
          metric.labels.queue === runtime?.paymentEventsQueue &&
          metric.labels.result === 'duplicate',
      )?.value;
      return duplicateCount && duplicateCount > 0 ? duplicateCount : false;
    });

    const confirmationEvents = await bookingDatabase
      .select()
      .from(bookingOutbox)
      .where(
        and(
          eq(bookingOutbox.type, 'booking.confirmed'),
          sql`${bookingOutbox.payload}->'data'->>'bookingId' = ${booking.id}`,
        ),
      );
    const issued = await bookingDatabase
      .select()
      .from(tickets)
      .where(eq(tickets.bookingId, booking.id));
    expect(confirmationEvents).toHaveLength(1);
    expect(issued).toHaveLength(1);
    await expectCrossServiceAudit();
  });

  it('deduplicates a repeated provider webhook', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    const webhook = successWebhook(payment);
    await paymentService.handleWebhook(webhook);
    await paymentService.handleWebhook(webhook);

    const deliveries = await paymentDatabase
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.providerEventId, webhook.providerEventId));
    const successEvents = await paymentDatabase
      .select()
      .from(paymentOutbox)
      .where(
        and(
          eq(paymentOutbox.type, 'payment.succeeded'),
          sql`${paymentOutbox.payload}->'data'->>'bookingId' = ${booking.id}`,
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(successEvents).toHaveLength(1);

    await runtime.paymentRelay.relayOnce();
    await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CONFIRMED' ? row : false,
      ),
    );
    await expectCrossServiceAudit();
  });

  it('cancels a pending booking when its event is cancelled', async () => {
    runtime = await startRuntime();
    await runtime.startBookingPaymentConsumer();
    const { booking, payment } = await createBookingAndPayment(runtime);
    const cancellation = makeTestEvent('event.cancelled', {
      eventId: booking.eventId,
      reason: 'Venue closed',
    });
    await runtime.messaging.publish(cancellation);

    await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CANCELLED' ? row : false,
      ),
    );
    const [blockedSeat] = await bookingDatabase
      .select()
      .from(bookingSeats)
      .where(
        and(
          eq(bookingSeats.eventId, booking.eventId),
          eq(bookingSeats.seatId, 'A1'),
        ),
      );
    expect(blockedSeat).toMatchObject({
      status: 'BLOCKED',
      bookingId: null,
      heldUntil: null,
    });

    await runtime.bookingRelay.relayOnce();
    const cancelledPayment = await waitFor(() =>
      paymentDatabase
        .select()
        .from(payments)
        .where(eq(payments.id, payment.id))
        .then(([row]) => (row?.status === 'CANCELLED' ? row : false)),
    );
    expect(cancelledPayment.status).toBe('CANCELLED');
    expect(
      await paymentDatabase
        .select()
        .from(refunds)
        .where(eq(refunds.paymentId, payment.id)),
    ).toHaveLength(0);
    await expectCrossServiceAudit();
  });

  it('processes a queued success after the booking consumer restarts', async () => {
    runtime = await startRuntime();
    const { booking, payment } = await createBookingAndPayment(runtime);
    await paymentService.handleWebhook(successWebhook(payment));
    await runtime.paymentRelay.relayOnce();

    const queued = await waitFor(async () => {
      const result = await runtime?.publisherChannel.checkQueue(
        runtime.paymentEventsQueue,
      );
      return result && result.messageCount > 0 ? result : false;
    });
    expect(queued.messageCount).toBeGreaterThan(0);
    expect((await getBooking(booking.id))?.status).toBe('AWAITING_PAYMENT');

    await runtime.startBookingPaymentConsumer();
    const confirmed = await waitFor(() =>
      getBooking(booking.id).then((row) =>
        row?.status === 'CONFIRMED' ? row : false,
      ),
    );
    expect(confirmed.status).toBe('CONFIRMED');
    await expectCrossServiceAudit();
  });

  it('retains payment outbox rows through a 30-second RabbitMQ outage and flushes after recovery', async () => {
    runtime = await startRuntime({ useBrokerProxy: true });
    await runtime.startBookingPaymentConsumer();
    const first = await createBookingAndPayment(runtime);
    const second = await createBookingAndPayment(runtime);
    const duringOutage = await createBookingAndPayment(runtime);
    await paymentService.handleWebhook(successWebhook(first.payment));
    await paymentService.handleWebhook(successWebhook(second.payment));

    const proxy = runtime.proxy;
    if (!proxy) throw new Error('Broker proxy was not initialized');
    proxy.setAvailable(false);
    let relayFailure: unknown;
    let relayComplete = false;
    const firstRelay = runtime.paymentRelay.relayOnce().then(
      () => {
        relayComplete = true;
      },
      (error: unknown) => {
        relayFailure = error;
        relayComplete = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    await paymentService.handleWebhook(successWebhook(duringOutage.payment));
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const unpublishedDuringOutage = await paymentDatabase
      .select()
      .from(paymentOutbox)
      .where(isNull(paymentOutbox.publishedAt));
    expect(unpublishedDuringOutage).toHaveLength(3);

    proxy.setAvailable(true);
    await waitFor(() => Promise.resolve(relayComplete || false), 20_000);
    await firstRelay;
    if (relayFailure) await runtime.paymentRelay.relayOnce();
    await runtime.paymentRelay.relayOnce();

    for (const booking of [
      first.booking,
      second.booking,
      duringOutage.booking,
    ]) {
      await waitFor(() =>
        getBooking(booking.id).then((row) =>
          row?.status === 'CONFIRMED' ? row : false,
        ),
      );
    }
    await expectCrossServiceAudit();
  });

  async function startRuntime(
    options: { useBrokerProxy?: boolean } = {},
  ): Promise<SagaRuntime> {
    const previousAmqpUrl = process.env.AMQP_URL;
    const proxy = options.useBrokerProxy
      ? await createBrokerProxy(amqpUrl)
      : undefined;
    if (proxy) process.env.AMQP_URL = proxy.url;
    const messaging = new MessagingService();
    await messaging.onModuleInit();
    const publisher = connect([process.env.AMQP_URL ?? amqpUrl]);
    const publisherChannel = publisher.createChannel({
      confirm: true,
      json: false,
    });
    await publisherChannel.waitForConnect();
    const suffix = randomUUID();
    const paymentEventsQueue = `ticketforge.saga.integration.${suffix}.booking-payment`;
    const catalogEventsQueue = `ticketforge.saga.integration.${suffix}.booking-catalog`;
    const bookingEventsQueue = `ticketforge.saga.integration.${suffix}.payment-booking`;
    const queues = [
      {
        name: paymentEventsQueue,
        types: ['payment.succeeded', 'payment.failed'] as const,
      },
      {
        name: catalogEventsQueue,
        types: ['event.published', 'event.updated', 'event.cancelled'] as const,
      },
      {
        name: bookingEventsQueue,
        types: [
          'booking.created',
          'booking.cancelled',
          'booking.expired',
          'refund.requested',
        ] as const,
      },
    ];
    for (const queue of queues) {
      await publisherChannel.assertQueue(queue.name, { durable: false });
      for (const type of queue.types) {
        await publisherChannel.bindQueue(
          queue.name,
          EVENT_EXCHANGE,
          routingKeys[type],
        );
      }
    }

    const paymentEventsConsumer = new PaymentEventsConsumer(
      messaging,
      bookingDatabase,
      new OutboxService(),
    );
    const bookingEventsConsumer = new BookingEventsConsumer(
      messaging,
      paymentDatabase,
      new OutboxService(),
    );
    await new CatalogEventsConsumer(
      messaging,
      bookingDatabase,
      new OutboxService(),
    ).onModuleInit(catalogEventsQueue);
    await bookingEventsConsumer.onModuleInit(bookingEventsQueue);
    const bookingRelay = new OutboxRelay(bookingDatabase, messaging);
    const paymentRelay = new OutboxRelay(paymentDatabase, messaging);

    let bookingPaymentConsumerStarted = false;
    return {
      messaging,
      bookingRelay,
      paymentRelay,
      paymentEventsQueue,
      publisherChannel,
      proxy,
      startBookingPaymentConsumer: async () => {
        if (bookingPaymentConsumerStarted) return;
        await paymentEventsConsumer.onModuleInit(paymentEventsQueue);
        bookingPaymentConsumerStarted = true;
      },
      close: async () => {
        await Promise.all([
          bookingRelay.onModuleDestroy(),
          paymentRelay.onModuleDestroy(),
        ]);
        proxy?.setAvailable(true);
        await messaging.onModuleDestroy();
        await publisherChannel.waitForConnect();
        for (const queue of queues)
          await publisherChannel.deleteQueue(queue.name);
        await publisherChannel.close();
        await publisher.close();
        await proxy?.close();
        if (previousAmqpUrl === undefined) delete process.env.AMQP_URL;
        else process.env.AMQP_URL = previousAmqpUrl;
      },
    };
  }

  async function createBookingAndPayment(
    runtime: SagaRuntime,
    userId = randomUUID(),
    eventTitle = 'Saga integration event',
  ): Promise<{
    booking: typeof bookingRows.$inferSelect;
    payment: typeof payments.$inferSelect;
  }> {
    const eventId = randomUUID();
    await bookingDatabase.insert(eventSnapshots).values({
      eventId,
      organizerId: randomUUID(),
      title: eventTitle,
      startsAt: new Date(Date.now() + 86_400_000),
      status: 'PUBLISHED',
      currency: 'NPR',
    });
    await bookingDatabase.insert(bookingSeats).values([
      {
        eventId,
        seatId: 'A1',
        sectionId: 'A',
        tierId: 'standard',
        priceMinor: 4_321,
      },
    ]);
    await bookingService.createHold(userId, randomUUID(), {
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

    await runtime.bookingRelay.relayOnce();
    const payment = await waitFor(() =>
      paymentDatabase
        .select()
        .from(payments)
        .where(eq(payments.bookingId, booking.id))
        .then(([row]) => row ?? false),
    );
    return { booking, payment };
  }

  function successWebhook(payment: typeof payments.$inferSelect) {
    return {
      providerEventId: randomUUID(),
      paymentId: payment.id,
      bookingId: payment.bookingId,
      outcome: 'succeeded',
      providerRef: `mock:${payment.id}`,
    };
  }

  async function getBooking(id: string) {
    const [booking] = await bookingDatabase
      .select()
      .from(bookingRows)
      .where(eq(bookingRows.id, id));
    return booking;
  }

  async function expectCrossServiceAudit(): Promise<void> {
    const allBookings = await bookingDatabase.select().from(bookingRows);
    const allPayments = await paymentDatabase.select().from(payments);
    const allRefunds = await paymentDatabase.select().from(refunds);
    const bookingById = new Map(
      allBookings.map((booking) => [booking.id, booking]),
    );
    const refundPaymentIds = new Set(
      allRefunds.map((refund) => refund.paymentId),
    );
    const confirmedViolations = allBookings
      .filter((booking) => booking.status === 'CONFIRMED')
      .filter((booking) => {
        const matchingPayments = allPayments.filter(
          (payment) => payment.bookingId === booking.id,
        );
        return (
          matchingPayments.length !== 1 ||
          matchingPayments[0]?.status !== 'SUCCEEDED' ||
          matchingPayments[0]?.amountMinor !== booking.totalMinor
        );
      });
    const missingRefunds = allPayments
      .filter((payment) => payment.status === 'SUCCEEDED')
      .filter(
        (payment) => bookingById.get(payment.bookingId)?.status !== 'CONFIRMED',
      )
      .filter((payment) => !refundPaymentIds.has(payment.id));
    const soldSeats = await bookingDatabase
      .select()
      .from(bookingSeats)
      .where(eq(bookingSeats.status, 'SOLD'));
    const soldSeatViolations = soldSeats.filter(
      (seat) =>
        !seat.bookingId ||
        bookingById.get(seat.bookingId)?.status !== 'CONFIRMED',
    );
    expect({
      confirmedViolations: confirmedViolations.map((booking) => booking.id),
      missingRefunds: missingRefunds.map((payment) => payment.id),
      soldSeatViolations: soldSeatViolations.map((seat) => seat.seatId),
    }).toEqual({
      confirmedViolations: [],
      missingRefunds: [],
      soldSeatViolations: [],
    });
  }

  async function createBrokerProxy(targetUrl: string): Promise<BrokerProxy> {
    const target = new URL(targetUrl);
    if (target.protocol !== 'amqp:')
      throw new Error('The outage test requires an amqp:// broker URL');
    const sockets = new Set<Socket>();
    let available = true;
    const server: Server = createServer((client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      if (!available) {
        client.destroy();
        return;
      }
      const upstream = connectTcp(Number(target.port || 5672), target.hostname);
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Broker proxy did not bind a TCP port');
    const proxyUrl = new URL(targetUrl);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(address.port);

    return {
      url: proxyUrl.toString(),
      setAvailable: (nextAvailable) => {
        available = nextAvailable;
        if (!available) {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        }
      },
      close: async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      },
    };
  }
});
