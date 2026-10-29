import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDrizzle, DomainError } from '@tf/common';
import { parseEvent } from '@tf/contracts';
import {
  createPerTestDatabase,
  makeTestEvent,
  readBookingInvariantViolations,
  waitFor,
} from '@tf/testing';
import { MessagingService } from '@tf/messaging';
import { OutboxService } from '@tf/outbox';
import { BookingService } from './booking.service';
import { CatalogEventsConsumer } from './catalog-events.consumer';
import { PaymentEventsConsumer } from './payment-events.consumer';
import { createTicketQrToken, verifyTicketQrToken } from './ticket-qr';
import {
  bookingItems,
  bookings,
  eventSnapshots,
  idempotencyKeys,
  outbox,
  seats,
  tickets,
} from './database/schema';

const integrationDescribe =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integrationDescribe('BookingService integration', () => {
  jest.setTimeout(60_000);

  let adminPool: Pool;
  let testDatabase: Awaited<ReturnType<typeof createPerTestDatabase>>;
  let databasePool: Pool;
  let database: ReturnType<typeof createDrizzle>;
  let bookingService: BookingService;
  let catalogEventsConsumer: CatalogEventsConsumer;
  let paymentEventsConsumer: PaymentEventsConsumer;

  beforeAll(async () => {
    if (process.env.HOLD_TTL_SECONDS !== '5') {
      throw new Error(
        'Set HOLD_TTL_SECONDS=5 to run booking integration tests',
      );
    }
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
      migrationsFolder: `${process.cwd()}/apps/booking/migrations`,
    });
    bookingService = new BookingService(
      databasePool,
      database,
      new OutboxService(),
    );
    catalogEventsConsumer = new CatalogEventsConsumer(
      new MessagingService(),
      database,
      new OutboxService(),
    );
    paymentEventsConsumer = new PaymentEventsConsumer(
      new MessagingService(),
      database,
      new OutboxService(),
    );
  });

  afterAll(async () => {
    if (bookingService) await bookingService.onModuleDestroy();
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
  });

  async function createInventory(
    seatIds: string[],
    organizerId = randomUUID(),
  ): Promise<string> {
    const eventId = randomUUID();
    await database.insert(eventSnapshots).values({
      eventId,
      organizerId,
      title: 'Concurrency integration event',
      startsAt: new Date(Date.now() + 86_400_000),
      status: 'PUBLISHED',
    });
    await database.insert(seats).values(
      seatIds.map((seatId) => ({
        eventId,
        seatId,
        sectionId: 'A',
        tierId: 'standard',
        priceMinor: 100,
      })),
    );
    return eventId;
  }

  async function issueTicket(eventId: string, seatId: string) {
    const userId = randomUUID();
    const secret = 'booking-payment-test-secret';
    return withQrSecret(secret, async () => {
      await bookingService.createHold(userId, randomUUID(), {
        eventId,
        seatIds: [seatId],
      });
      const [booking] = await database
        .select()
        .from(bookings)
        .where(and(eq(bookings.userId, userId), eq(bookings.eventId, eventId)));
      if (!booking) throw new Error('Booking creation returned no row');
      const payment = makeTestEvent('payment.succeeded', {
        paymentId: randomUUID(),
        bookingId: booking.id,
        amountMinor: booking.totalMinor,
        providerRef: `mock:${booking.id}`,
      });
      await database.transaction((transaction) =>
        paymentEventsConsumer.handle(payment, transaction),
      );
      const [ticket] = await database
        .select()
        .from(tickets)
        .where(eq(tickets.bookingId, booking.id));
      if (!ticket) throw new Error('Ticket issuance returned no row');
      return {
        userId,
        bookingId: booking.id,
        ticketId: ticket.id,
        token: createTicketQrToken(ticket.id, secret),
      };
    });
  }

  async function withQrSecret<T>(
    secret: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = process.env.QR_SECRET;
    process.env.QR_SECRET = secret;
    try {
      return await operation();
    } finally {
      if (previous === undefined) delete process.env.QR_SECRET;
      else process.env.QR_SECRET = previous;
    }
  }

  async function expectBookingInvariants(): Promise<void> {
    await expect(readBookingInvariantViolations(databasePool)).resolves.toEqual(
      {
        heldSeatsWithoutBooking: 0,
        heldSeatsForInactiveBooking: 0,
        duplicateActiveBookingSeats: 0,
      },
    );
  }

  it('allows exactly one of 50 concurrent requests for the same seat', async () => {
    const eventId = await createInventory(['A1']);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        bookingService.createHold(randomUUID(), `same-seat-${index}`, {
          eventId,
          seatIds: ['A1'],
        }),
      ),
    );
    const successes = results.filter((result) => result.status === 'fulfilled');
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' &&
        result.reason instanceof DomainError &&
        result.reason.code === 'SEAT_UNAVAILABLE' &&
        result.reason.status === 409,
    );

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(49);
    const [heldSeat] = await database
      .select()
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.status, 'HELD')));
    expect(heldSeat?.seatId).toBe('A1');
    await expectBookingInvariants();
  });

  it('keeps overlapping seat-set requests all-or-nothing without deadlocks', async () => {
    const eventId = await createInventory(['A1', 'A2', 'A3', 'A4', 'A5']);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) =>
        bookingService.createHold(randomUUID(), `overlap-${index}`, {
          eventId,
          seatIds: index % 2 === 0 ? ['A1', 'A2', 'A3'] : ['A3', 'A4', 'A5'],
        }),
      ),
    );
    const successes = results.filter((result) => result.status === 'fulfilled');
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' &&
        result.reason instanceof DomainError &&
        result.reason.code === 'SEAT_UNAVAILABLE' &&
        result.reason.status === 409,
    );
    const heldSeats = await database
      .select()
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.status, 'HELD')));
    const heldItems = await database
      .select()
      .from(bookingItems)
      .where(eq(bookingItems.eventId, eventId));

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(29);
    expect(heldSeats).toHaveLength(3);
    expect(new Set(heldSeats.map((seat) => seat.bookingId)).size).toBe(1);
    expect(heldItems).toHaveLength(3);
    await expectBookingInvariants();
  });

  it('lets another user claim an expired hold while its booking remains awaiting payment', async () => {
    const eventId = await createInventory(['A1']);
    const expiredBookingId = randomUUID();
    const firstUserId = randomUUID();
    const nextUserId = randomUUID();
    const expiredAt = new Date(Date.now() - 1_000);
    await database.insert(bookings).values({
      id: expiredBookingId,
      userId: firstUserId,
      eventId,
      status: 'AWAITING_PAYMENT',
      totalMinor: 100,
      currency: 'NPR',
      expiresAt: expiredAt,
    });
    await database.insert(bookingItems).values({
      bookingId: expiredBookingId,
      eventId,
      seatId: 'A1',
      priceMinor: 100,
    });
    await database
      .update(seats)
      .set({
        status: 'HELD',
        bookingId: expiredBookingId,
        heldUntil: expiredAt,
      })
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A1')));

    await bookingService.createHold(nextUserId, 'claim-expired-seat', {
      eventId,
      seatIds: ['A1'],
    });
    const [stillAwaitingPayment] = await database
      .select()
      .from(bookings)
      .where(eq(bookings.id, expiredBookingId));
    expect(stillAwaitingPayment?.status).toBe('AWAITING_PAYMENT');

    const [claimedSeat] = await database
      .select()
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A1')));
    expect(claimedSeat?.status).toBe('HELD');
    expect(claimedSeat?.bookingId).not.toBe(expiredBookingId);

    await bookingService.sweepExpiredBookings();
    await expectBookingInvariants();
  });

  it('creates one booking for ten parallel requests with the same idempotency key', async () => {
    const eventId = await createInventory(['A1']);
    const userId = randomUUID();
    const idempotencyKey = 'parallel-idempotent-replay';
    const input = { eventId, seatIds: ['A1'] };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        bookingService.createHold(userId, idempotencyKey, input),
      ),
    );
    const matchingBookings = await database
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.eventId, eventId)));
    const keyRows = await database
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.key, idempotencyKey),
        ),
      );
    const createdOutboxRows = await databasePool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox
       WHERE type = 'booking.created' AND payload->'data'->>'bookingId' = $1`,
      [matchingBookings[0]?.id],
    );

    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(matchingBookings).toHaveLength(1);
    expect(keyRows).toHaveLength(1);
    expect(createdOutboxRows.rows[0]?.count).toBe(1);
    await expectBookingInvariants();
  });

  it('allows reuse after expiry without the sweeper, then expires and releases an unpaid booking', async () => {
    const eventId = randomUUID();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    await database.insert(eventSnapshots).values({
      eventId,
      organizerId: randomUUID(),
      title: 'Expiry integration event',
      startsAt: new Date(Date.now() + 86_400_000),
      status: 'PUBLISHED',
    });
    await database.insert(seats).values([
      {
        eventId,
        seatId: 'A1',
        sectionId: 'A',
        tierId: 'standard',
        priceMinor: 100,
      },
      {
        eventId,
        seatId: 'A2',
        sectionId: 'A',
        tierId: 'standard',
        priceMinor: 100,
      },
    ]);

    await bookingService.createHold(firstUserId, 'first-hold', {
      eventId,
      seatIds: ['A1'],
    });
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const availability = await bookingService.getAvailability(eventId);
    expect(
      availability.sections[0]?.seats.find((seat) => seat.seatId === 'A1')
        ?.status,
    ).toBe('AVAILABLE');

    await bookingService.createHold(secondUserId, 'replacement-hold', {
      eventId,
      seatIds: ['A1'],
    });
    const [replacementSeatOwner] = await database
      .select({ bookingId: seats.bookingId })
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A1')));
    if (!replacementSeatOwner?.bookingId)
      throw new Error('Replacement hold did not retain the seat');
    const replacementExpiry = new Date(Date.now() + 60_000);
    await database
      .update(bookings)
      .set({ expiresAt: replacementExpiry })
      .where(eq(bookings.id, replacementSeatOwner.bookingId));
    await database
      .update(seats)
      .set({ heldUntil: replacementExpiry })
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A1')));

    await bookingService.createHold(firstUserId, 'second-hold', {
      eventId,
      seatIds: ['A2'],
    });
    const [expiringSeatOwner] = await database
      .select({ bookingId: seats.bookingId })
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A2')));
    if (!expiringSeatOwner?.bookingId)
      throw new Error('Expiring hold did not retain the seat');
    const expiringBookingId = expiringSeatOwner.bookingId;
    bookingService.onModuleInit();

    const expiredBooking = await waitFor(
      async () => {
        const [booking] = await database
          .select()
          .from(bookings)
          .where(eq(bookings.id, expiringBookingId));
        return booking?.status === 'EXPIRED' ? booking : false;
      },
      20_000,
      100,
    );

    expect(expiredBooking.id).toBe(expiringBookingId);
    const [releasedSeat, replacementSeat] = await Promise.all([
      database.select().from(seats).where(eq(seats.seatId, 'A2')),
      database.select().from(seats).where(eq(seats.seatId, 'A1')),
    ]);
    expect(releasedSeat[0]).toMatchObject({
      status: 'AVAILABLE',
      bookingId: null,
      heldUntil: null,
    });
    expect(replacementSeat[0]).toMatchObject({
      status: 'HELD',
      bookingId: replacementSeatOwner.bookingId,
    });

    const expiryEvents = await database
      .select()
      .from(outbox)
      .where(eq(outbox.type, 'booking.expired'));
    const matchingExpiryEvent = expiryEvents.find((event) => {
      const data = event.payload.data;
      return (
        typeof data === 'object' &&
        data !== null &&
        'bookingId' in data &&
        data.bookingId === expiringBookingId
      );
    });
    expect(matchingExpiryEvent?.payload).toMatchObject({
      type: 'booking.expired',
      data: {
        bookingId: expiringBookingId,
        userId: firstUserId,
        eventId,
      },
    });
  });

  it('confirms an active booking once, sells its seats, and issues signed tickets', async () => {
    const eventId = await createInventory(['A1', 'A2']);
    const userId = randomUUID();
    await bookingService.createHold(userId, 'confirm-payment', {
      eventId,
      seatIds: ['A1', 'A2'],
    });
    const [booking] = await database
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.eventId, eventId)));
    if (!booking) throw new Error('Booking creation returned no row');
    const envelope = makeTestEvent('payment.succeeded', {
      paymentId: randomUUID(),
      bookingId: booking.id,
      amountMinor: booking.totalMinor,
      providerRef: `mock:${booking.id}`,
    });
    const previousQrSecret = process.env.QR_SECRET;
    process.env.QR_SECRET = 'booking-payment-test-secret';

    try {
      await database.transaction((transaction) =>
        paymentEventsConsumer.handle(envelope, transaction),
      );
      await database.transaction((transaction) =>
        paymentEventsConsumer.handle(envelope, transaction),
      );
    } finally {
      if (previousQrSecret === undefined) delete process.env.QR_SECRET;
      else process.env.QR_SECRET = previousQrSecret;
    }

    const [confirmedBooking] = await database
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    const soldSeats = await database
      .select()
      .from(seats)
      .where(eq(seats.bookingId, booking.id));
    const issuedTickets = await database
      .select()
      .from(tickets)
      .where(eq(tickets.bookingId, booking.id));
    const confirmedOutbox = await databasePool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox
       WHERE type = 'booking.confirmed' AND payload->'data'->>'bookingId' = $1`,
      [booking.id],
    );
    const confirmation = parseEvent(
      'booking.confirmed',
      confirmedOutbox.rows[0]?.payload,
    );

    expect(confirmedBooking?.status).toBe('CONFIRMED');
    expect(soldSeats).toHaveLength(2);
    expect(
      soldSeats.every(
        (seat) => seat.status === 'SOLD' && seat.heldUntil === null,
      ),
    ).toBe(true);
    expect(issuedTickets).toHaveLength(2);
    expect(confirmation.type).toBe('booking.confirmed');
    if (confirmation.type !== 'booking.confirmed')
      throw new Error('Incorrect confirmation event type');
    expect(confirmation.data.tickets).toHaveLength(2);
    for (const ticket of confirmation.data.tickets) {
      expect(ticket.qrToken).toBe(
        createTicketQrToken(ticket.ticketId, 'booking-payment-test-secret'),
      );
      expect(
        verifyTicketQrToken(ticket.qrToken, 'booking-payment-test-secret'),
      ).toBe(ticket.ticketId);
    }
  });

  it('lists and reads only the current customer tickets with signed QR tokens', async () => {
    const eventId = await createInventory(['A1']);
    const ticket = await issueTicket(eventId, 'A1');

    await withQrSecret('booking-payment-test-secret', async () => {
      const ownerTickets = await bookingService.listTickets(ticket.userId);
      expect(ownerTickets).toHaveLength(1);
      expect(ownerTickets[0]).toMatchObject({
        id: ticket.ticketId,
        eventId,
        seatId: 'A1',
        status: 'VALID',
        qrToken: ticket.token,
      });
      await expect(
        bookingService.getTicket(ticket.userId, ticket.ticketId),
      ).resolves.toMatchObject({
        id: ticket.ticketId,
        qrToken: ticket.token,
      });
      await expect(
        bookingService.getTicket(randomUUID(), ticket.ticketId),
      ).rejects.toMatchObject({
        code: 'TICKET_NOT_FOUND',
        status: 404,
      });
    });
  });

  it('checks in a ticket once and reports usedAt on a concurrent scan', async () => {
    const organizerId = randomUUID();
    const eventId = await createInventory(['A1'], organizerId);
    const ticket = await issueTicket(eventId, 'A1');

    await withQrSecret('booking-payment-test-secret', async () => {
      await expect(
        bookingService.checkIn(randomUUID(), { token: ticket.token }),
      ).rejects.toMatchObject({
        code: 'EVENT_FORBIDDEN',
        status: 403,
      });
      const modifiedIdToken = ticket.token.replace(
        ticket.ticketId,
        randomUUID(),
      );
      await expect(
        bookingService.checkIn(organizerId, { token: modifiedIdToken }),
      ).rejects.toMatchObject({
        code: 'TICKET_INVALID',
        status: 422,
      });

      const scans = await Promise.allSettled([
        bookingService.checkIn(organizerId, { token: ticket.token }),
        bookingService.checkIn(organizerId, { token: ticket.token }),
      ]);
      const successfulScans = scans.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejectedScans = scans.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(successfulScans).toHaveLength(1);
      expect(rejectedScans).toHaveLength(1);
      const rejectedReason: unknown = rejectedScans[0]?.reason;
      expect(rejectedReason).toBeInstanceOf(DomainError);
      if (!(rejectedReason instanceof DomainError))
        throw new Error('Concurrent scan returned no domain error');
      expect(rejectedReason.code).toBe('TICKET_ALREADY_USED');
      expect(rejectedReason.status).toBe(409);
      expect(typeof rejectedReason.details?.usedAt).toBe('string');
    });
  });

  it('rejects a void ticket at check-in', async () => {
    const organizerId = randomUUID();
    const eventId = await createInventory(['A1'], organizerId);
    const ticket = await issueTicket(eventId, 'A1');
    await database
      .update(eventSnapshots)
      .set({ startsAt: new Date(Date.now() + 48 * 60 * 60 * 1_000) })
      .where(eq(eventSnapshots.eventId, eventId));
    await bookingService.cancelBooking(ticket.userId, ticket.bookingId);

    await withQrSecret('booking-payment-test-secret', async () => {
      await expect(
        bookingService.checkIn(organizerId, { token: ticket.token }),
      ).rejects.toMatchObject({
        code: 'TICKET_VOID',
        status: 410,
      });
    });
  });

  it('cancels a confirmed booking inside the window, voids tickets, and requests a refund', async () => {
    const eventId = await createInventory(['A1']);
    const userId = randomUUID();
    await database
      .update(eventSnapshots)
      .set({ startsAt: new Date(Date.now() + 26 * 60 * 60 * 1_000) })
      .where(eq(eventSnapshots.eventId, eventId));
    await bookingService.createHold(userId, 'cancel-confirmed', {
      eventId,
      seatIds: ['A1'],
    });
    const [booking] = await database
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.eventId, eventId)));
    if (!booking) throw new Error('Booking creation returned no row');
    const paymentId = randomUUID();
    const previousQrSecret = process.env.QR_SECRET;
    process.env.QR_SECRET = 'booking-payment-test-secret';
    try {
      await database.transaction((transaction) =>
        paymentEventsConsumer.handle(
          makeTestEvent('payment.succeeded', {
            paymentId,
            bookingId: booking.id,
            amountMinor: booking.totalMinor,
            providerRef: `mock:${booking.id}`,
          }),
          transaction,
        ),
      );
    } finally {
      if (previousQrSecret === undefined) delete process.env.QR_SECRET;
      else process.env.QR_SECRET = previousQrSecret;
    }

    await database
      .update(eventSnapshots)
      .set({ startsAt: new Date(Date.now() + 23 * 60 * 60 * 1_000) })
      .where(eq(eventSnapshots.eventId, eventId));
    await expect(
      bookingService.cancelBooking(userId, booking.id),
    ).rejects.toMatchObject({
      code: 'CANCELLATION_WINDOW_CLOSED',
      status: 409,
    });
    await database
      .update(eventSnapshots)
      .set({ startsAt: new Date(Date.now() + 26 * 60 * 60 * 1_000) })
      .where(eq(eventSnapshots.eventId, eventId));

    const cancelled = await bookingService.cancelBooking(userId, booking.id);
    await bookingService.cancelBooking(userId, booking.id);
    const [finalBooking] = await database
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    const [seat] = await database
      .select()
      .from(seats)
      .where(eq(seats.eventId, eventId));
    const bookingTickets = await database
      .select()
      .from(tickets)
      .where(eq(tickets.bookingId, booking.id));
    const refundEvents = await databasePool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox
       WHERE type = 'refund.requested' AND payload->'data'->>'bookingId' = $1`,
      [booking.id],
    );
    const refund = parseEvent(
      'refund.requested',
      refundEvents.rows[0]?.payload,
    );

    expect(cancelled.status).toBe('CANCELLED');
    expect(finalBooking?.paymentId).toBe(paymentId);
    expect(seat).toMatchObject({
      status: 'AVAILABLE',
      bookingId: null,
      heldUntil: null,
    });
    expect(bookingTickets).toHaveLength(1);
    expect(bookingTickets[0]?.status).toBe('VOID');
    expect(refund.type).toBe('refund.requested');
    if (refund.type !== 'refund.requested')
      throw new Error('Incorrect refund event type');
    expect(refund.data).toMatchObject({
      bookingId: booking.id,
      paymentRef: paymentId,
      reason: 'USER_CANCELLED',
    });
    const repeatedRefunds = await databasePool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox
       WHERE type = 'refund.requested' AND payload->'data'->>'bookingId' = $1`,
      [booking.id],
    );
    expect(repeatedRefunds.rows[0]?.count).toBe(1);
  });

  it('fans event cancellation out to active bookings and blocks inventory', async () => {
    const eventId = await createInventory(['A1', 'A2', 'A3']);
    const unpaidUserId = randomUUID();
    const confirmedUserId = randomUUID();
    await bookingService.createHold(unpaidUserId, 'event-cancel-unpaid', {
      eventId,
      seatIds: ['A1'],
    });
    await bookingService.createHold(confirmedUserId, 'event-cancel-confirmed', {
      eventId,
      seatIds: ['A2'],
    });
    const [unpaidBooking] = await database
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.userId, unpaidUserId), eq(bookings.eventId, eventId)),
      );
    const [confirmedBooking] = await database
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.userId, confirmedUserId),
          eq(bookings.eventId, eventId),
        ),
      );
    if (!unpaidBooking || !confirmedBooking)
      throw new Error('Booking creation returned no row');

    const paymentId = randomUUID();
    const previousQrSecret = process.env.QR_SECRET;
    process.env.QR_SECRET = 'booking-payment-test-secret';
    try {
      await database.transaction((transaction) =>
        paymentEventsConsumer.handle(
          makeTestEvent('payment.succeeded', {
            paymentId,
            bookingId: confirmedBooking.id,
            amountMinor: confirmedBooking.totalMinor,
            providerRef: `mock:${confirmedBooking.id}`,
          }),
          transaction,
        ),
      );
    } finally {
      if (previousQrSecret === undefined) delete process.env.QR_SECRET;
      else process.env.QR_SECRET = previousQrSecret;
    }

    await database.transaction((transaction) =>
      catalogEventsConsumer.handle(
        makeTestEvent('event.cancelled', { eventId, reason: 'Venue closed' }),
        transaction,
      ),
    );

    const finalBookings = await database
      .select()
      .from(bookings)
      .where(eq(bookings.eventId, eventId));
    const eventSeats = await database
      .select()
      .from(seats)
      .where(eq(seats.eventId, eventId));
    const issuedTickets = await database
      .select()
      .from(tickets)
      .where(eq(tickets.bookingId, confirmedBooking.id));
    const cancellationOutbox = await databasePool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox
       WHERE type = 'booking.cancelled' AND payload->'data'->>'eventId' = $1`,
      [eventId],
    );
    const refundOutbox = await databasePool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox
       WHERE type = 'refund.requested'
         AND payload->'data'->>'bookingId' = ANY($1::text[])`,
      [[unpaidBooking.id, confirmedBooking.id]],
    );
    const refund = parseEvent(
      'refund.requested',
      refundOutbox.rows[0]?.payload,
    );
    const [eventSnapshot] = await database
      .select()
      .from(eventSnapshots)
      .where(eq(eventSnapshots.eventId, eventId));

    expect(eventSnapshot?.status).toBe('CANCELLED');
    expect(finalBookings).toHaveLength(2);
    expect(
      finalBookings.every(
        (booking) =>
          booking.status === 'CANCELLED' &&
          booking.cancelReason === 'EVENT_CANCELLED',
      ),
    ).toBe(true);
    expect(eventSeats).toHaveLength(3);
    expect(
      eventSeats.every(
        (seat) =>
          seat.status === 'BLOCKED' &&
          seat.bookingId === null &&
          seat.heldUntil === null,
      ),
    ).toBe(true);
    expect(issuedTickets).toHaveLength(1);
    expect(issuedTickets[0]?.status).toBe('VOID');
    expect(cancellationOutbox.rows).toHaveLength(2);
    expect(refundOutbox.rows).toHaveLength(1);
    expect(refund.type).toBe('refund.requested');
    if (refund.type !== 'refund.requested')
      throw new Error('Incorrect refund event type');
    expect(refund.data).toMatchObject({
      bookingId: confirmedBooking.id,
      paymentRef: paymentId,
      reason: 'EVENT_CANCELLED',
    });
  });

  it('serializes event cancellation with a booking being created', async () => {
    const eventId = await createInventory(['A1']);
    const userId = randomUUID();
    const lockKey = 814_202_610;
    const lockClient = await databasePool.connect();
    const lockResult = await lockClient.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const lockPid = lockResult.rows[0]?.pid;
    if (lockPid === undefined)
      throw new Error('Could not read test lock session PID');
    await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
    await databasePool.query(`
      CREATE FUNCTION block_booking_insert_for_test() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${lockKey}::bigint);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await databasePool.query(`
      CREATE TRIGGER block_booking_insert_for_test
      BEFORE INSERT ON bookings
      FOR EACH ROW EXECUTE FUNCTION block_booking_insert_for_test()
    `);

    let bookingCreation: ReturnType<BookingService['createHold']> | undefined;
    try {
      bookingCreation = bookingService.createHold(userId, 'event-cancel-race', {
        eventId,
        seatIds: ['A1'],
      });
      await waitFor(async () => {
        const result = await databasePool.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting
           FROM pg_stat_activity
           WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
          [lockPid],
        );
        return result.rows[0]?.waiting ? result.rows[0].waiting : false;
      });

      const eventCancellation = database.transaction((transaction) =>
        catalogEventsConsumer.handle(
          makeTestEvent('event.cancelled', { eventId, reason: 'Venue closed' }),
          transaction,
        ),
      );
      await waitFor(async () => {
        const result = await databasePool.query<{ blocked: number }>(
          `SELECT count(*)::int AS blocked
           FROM pg_stat_activity
           WHERE pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
          [lockPid],
        );
        return (result.rows[0]?.blocked ?? 0) >= 2 ? true : false;
      });

      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [
        lockKey,
      ]);
      const created = await bookingCreation;
      if (
        typeof created !== 'object' ||
        created === null ||
        !('bookingId' in created) ||
        typeof created.bookingId !== 'string'
      ) {
        throw new Error(
          'Concurrent booking creation returned an invalid response',
        );
      }
      await eventCancellation;

      const [finalBooking] = await database
        .select()
        .from(bookings)
        .where(eq(bookings.id, created.bookingId));
      const [finalSeat] = await database
        .select()
        .from(seats)
        .where(eq(seats.eventId, eventId));
      expect(finalBooking).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'EVENT_CANCELLED',
      });
      expect(finalSeat).toMatchObject({
        status: 'BLOCKED',
        bookingId: null,
        heldUntil: null,
      });
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [
        lockKey,
      ]);
      lockClient.release();
      if (bookingCreation) await bookingCreation.catch(() => undefined);
      await databasePool.query(
        'DROP TRIGGER IF EXISTS block_booking_insert_for_test ON bookings',
      );
      await databasePool.query(
        'DROP FUNCTION IF EXISTS block_booking_insert_for_test()',
      );
    }
  });

  it('cancels a booking and releases its seats after payment failure', async () => {
    const eventId = await createInventory(['A1']);
    const userId = randomUUID();
    await bookingService.createHold(userId, 'failed-payment', {
      eventId,
      seatIds: ['A1'],
    });
    const [booking] = await database
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.eventId, eventId)));
    if (!booking) throw new Error('Booking creation returned no row');
    const envelope = makeTestEvent('payment.failed', {
      paymentId: randomUUID(),
      bookingId: booking.id,
      reason: 'Mock payment failed',
    });

    await database.transaction((transaction) =>
      paymentEventsConsumer.handle(envelope, transaction),
    );

    const [cancelledBooking] = await database
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    const [releasedSeat] = await database
      .select()
      .from(seats)
      .where(and(eq(seats.eventId, eventId), eq(seats.seatId, 'A1')));
    expect(cancelledBooking).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'PAYMENT_FAILED',
    });
    expect(releasedSeat).toMatchObject({
      status: 'AVAILABLE',
      bookingId: null,
      heldUntil: null,
    });
  });

  it('requests a late-payment refund without disturbing seats claimed by another user', async () => {
    const eventId = await createInventory(['A1']);
    const firstUserId = randomUUID();
    const nextUserId = randomUUID();
    await bookingService.createHold(firstUserId, 'late-payment-original', {
      eventId,
      seatIds: ['A1'],
    });
    const [expiredBooking] = await database
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.userId, firstUserId), eq(bookings.eventId, eventId)),
      );
    if (!expiredBooking)
      throw new Error('Original booking creation returned no row');
    await database
      .update(bookings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(bookings.id, expiredBooking.id));
    await bookingService.sweepExpiredBookings();
    await bookingService.createHold(nextUserId, 'late-payment-replacement', {
      eventId,
      seatIds: ['A1'],
    });
    const [replacementBooking] = await database
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.userId, nextUserId), eq(bookings.eventId, eventId)),
      );
    if (!replacementBooking)
      throw new Error('Replacement booking creation returned no row');

    const envelope = makeTestEvent('payment.succeeded', {
      paymentId: randomUUID(),
      bookingId: expiredBooking.id,
      amountMinor: expiredBooking.totalMinor,
      providerRef: `mock:${expiredBooking.id}`,
    });
    await database.transaction((transaction) =>
      paymentEventsConsumer.handle(envelope, transaction),
    );

    const [unchangedExpiredBooking] = await database
      .select()
      .from(bookings)
      .where(eq(bookings.id, expiredBooking.id));
    const [replacementSeat] = await database
      .select()
      .from(seats)
      .where(eq(seats.eventId, eventId));
    const refundEvents = await databasePool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox
       WHERE type = 'refund.requested' AND payload->'data'->>'bookingId' = $1`,
      [expiredBooking.id],
    );
    const refund = parseEvent(
      'refund.requested',
      refundEvents.rows[0]?.payload,
    );

    expect(unchangedExpiredBooking?.status).toBe('EXPIRED');
    expect(replacementSeat).toMatchObject({
      status: 'HELD',
      bookingId: replacementBooking.id,
    });
    expect(refund.type).toBe('refund.requested');
    if (refund.type !== 'refund.requested')
      throw new Error('Incorrect refund event type');
    expect(refund.data).toMatchObject({
      bookingId: expiredBooking.id,
      paymentRef: envelope.data.paymentId,
      reason: 'LATE_PAYMENT',
    });
  });
});
