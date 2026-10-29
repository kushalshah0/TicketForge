import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  createDrizzle,
  createPgPool,
  DomainError,
  getCorrelationId,
  MetricsService,
  type DrizzleDatabase,
} from '@tf/common';
import { makeEnvelope } from '@tf/contracts';
import { OutboxService } from '@tf/outbox';
import type { Pool } from 'pg';
import { z } from 'zod';
import { BookingStateMachine } from './booking-state-machine';
import {
  bookingItems,
  bookings,
  eventSnapshots,
  idempotencyKeys,
  seats,
  tickets,
} from './database/schema';
import { createTicketQrToken, verifyTicketQrToken } from './ticket-qr';

export const BOOKING_POOL = Symbol('BOOKING_POOL');
export const BOOKING_DATABASE = Symbol('BOOKING_DATABASE');

const holdRequestSchema = z
  .object({
    eventId: z.string().uuid(),
    seatIds: z.array(z.string().trim().min(1)).min(1).max(6),
  })
  .superRefine(({ seatIds }, context) => {
    if (new Set(seatIds).size !== seatIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['seatIds'],
        message: 'Duplicate seat IDs are not allowed',
      });
    }
  });
const holdTtlSeconds = positiveInteger(process.env.HOLD_TTL_SECONDS, 600);
const checkInSchema = z.object({ token: z.string().min(1) }).strict();

@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingService.name);
  private expiryTimer?: NodeJS.Timeout;
  private activeExpirySweep?: Promise<number>;

  constructor(
    @Inject(BOOKING_POOL) private readonly pool: Pool,
    @Inject(BOOKING_DATABASE) private readonly database: DrizzleDatabase,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    this.expiryTimer = setInterval(() => this.scheduleExpirySweep(), 15_000);
    this.expiryTimer.unref();
    this.scheduleExpirySweep();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    await this.activeExpirySweep;
    await this.pool.end();
  }

  async sweepExpiredBookings(): Promise<number> {
    if (this.activeExpirySweep) return this.activeExpirySweep;

    const run = this.expireBookingBatch();
    this.activeExpirySweep = run;
    try {
      return await run;
    } finally {
      if (this.activeExpirySweep === run) this.activeExpirySweep = undefined;
    }
  }

  async getAvailability(eventId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        eventId,
      )
    ) {
      throw new DomainError('Invalid event ID', 'VALIDATION_FAILED', 422);
    }
    const [snapshot] = await this.database
      .select({
        eventId: eventSnapshots.eventId,
        status: eventSnapshots.status,
      })
      .from(eventSnapshots)
      .where(
        and(
          eq(eventSnapshots.eventId, eventId),
          eq(eventSnapshots.status, 'PUBLISHED'),
        ),
      )
      .limit(1);
    if (!snapshot)
      throw new DomainError('Event not found', 'EVENT_NOT_FOUND', 404);

    const inventory = await this.database
      .select({
        sectionId: seats.sectionId,
        seatId: seats.seatId,
        status: sql<string>`CASE WHEN ${seats.status} = 'HELD' AND ${seats.heldUntil} <= now() THEN 'AVAILABLE' ELSE ${seats.status}::text END`,
      })
      .from(seats)
      .where(eq(seats.eventId, eventId));
    const sections = new Map<string, { seatId: string; status: string }[]>();
    for (const seat of inventory) {
      const section = sections.get(seat.sectionId) ?? [];
      section.push({ seatId: seat.seatId, status: seat.status });
      sections.set(seat.sectionId, section);
    }
    return {
      eventId,
      serverTime: new Date().toISOString(),
      sections: [...sections].map(([sectionId, sectionSeats]) => ({
        sectionId,
        seats: sectionSeats,
      })),
    };
  }

  async createHold(
    userId: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      this.metrics?.bookingHolds.inc({ result: 'invalid' });
      throw new DomainError(
        'Idempotency-Key header is required',
        'IDEMPOTENCY_KEY_REQUIRED',
        400,
      );
    }
    if (!z.string().uuid().safeParse(userId).success) {
      this.metrics?.bookingHolds.inc({ result: 'invalid' });
      throw new DomainError('Invalid user ID', 'INVALID_TOKEN', 401);
    }
    const parsed = holdRequestSchema.safeParse(input);
    if (!parsed.success) {
      this.metrics?.bookingHolds.inc({ result: 'invalid' });
      throw new DomainError(
        parsed.error.issues[0]?.message ?? 'Invalid booking request',
        'VALIDATION_FAILED',
        422,
      );
    }
    const seatIds = [...parsed.data.seatIds].sort();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ eventId: parsed.data.eventId, seatIds }))
      .digest('hex');
    const bookingId = randomUUID();

    try {
      const response = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${idempotencyKey}`}, 0))`,
        );
        const [existing] = await transaction
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.userId, userId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new DomainError(
              'Idempotency key was already used for another request',
              'IDEMPOTENCY_KEY_REUSED',
              422,
            );
          }
          return existing.responseBody;
        }

        const [event] = await transaction
          .select({
            eventId: eventSnapshots.eventId,
            status: eventSnapshots.status,
            currency: eventSnapshots.currency,
            startsInFuture: sql<boolean>`${eventSnapshots.startsAt} > now()`,
          })
          .from(eventSnapshots)
          .where(eq(eventSnapshots.eventId, parsed.data.eventId))
          .limit(1)
          .for('share');
        if (!event || event.status !== 'PUBLISHED') {
          throw new DomainError('Event not found', 'EVENT_NOT_FOUND', 404);
        }
        if (!event.startsInFuture) {
          throw new DomainError(
            'Event has already started',
            'EVENT_STARTED',
            409,
          );
        }

        const [active] = await transaction
          .select({ value: count() })
          .from(bookings)
          .where(
            and(
              eq(bookings.userId, userId),
              eq(bookings.eventId, event.eventId),
              eq(bookings.status, 'AWAITING_PAYMENT'),
              sql`${bookings.expiresAt} > now()`,
            ),
          );
        if ((active?.value ?? 0) >= 2) {
          throw new DomainError(
            'Too many active bookings for this event',
            'ACTIVE_BOOKING_LIMIT',
            409,
          );
        }

        const seatIdsSql = sql.join(
          seatIds.map((seatId) => sql`${seatId}`),
          sql`, `,
        );
        const result = await transaction.execute(sql`
        WITH target AS (
          SELECT event_id, seat_id
          FROM seats
          WHERE event_id = ${event.eventId}
            AND seat_id IN (${seatIdsSql})
            AND (status = 'AVAILABLE' OR (status = 'HELD' AND held_until < now()))
          ORDER BY seat_id
          FOR UPDATE SKIP LOCKED
        )
        UPDATE seats s
        SET status = 'HELD',
            booking_id = ${bookingId},
            held_until = now() + make_interval(secs => ${holdTtlSeconds}),
            version = s.version + 1
        FROM target t
        WHERE s.event_id = t.event_id AND s.seat_id = t.seat_id
        RETURNING s.seat_id AS "seatId", s.price_minor AS "priceMinor", s.held_until AS "heldUntil"
      `);
        const heldSeats = result.rows as unknown as Array<{
          seatId: string;
          priceMinor: number;
          heldUntil: unknown;
        }>;
        if (heldSeats.length !== seatIds.length) {
          throw new DomainError(
            'One or more requested seats are unavailable',
            'SEAT_UNAVAILABLE',
            409,
          );
        }

        const rawExpiresAt = heldSeats[0]?.heldUntil;
        const expiresAt =
          rawExpiresAt instanceof Date
            ? rawExpiresAt
            : typeof rawExpiresAt === 'string'
              ? new Date(rawExpiresAt)
              : undefined;
        if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
          throw new Error('Seat hold returned an invalid expiration');
        }
        const totalMinor = heldSeats.reduce(
          (total, seat) => total + seat.priceMinor,
          0,
        );
        const responseBody = {
          bookingId,
          eventId: event.eventId,
          seatIds,
          status: 'AWAITING_PAYMENT',
          totalMinor,
          currency: event.currency.trim(),
          expiresAt: expiresAt.toISOString(),
          serverTime: new Date(
            expiresAt.getTime() - holdTtlSeconds * 1_000,
          ).toISOString(),
        };
        await transaction.insert(bookings).values({
          id: bookingId,
          userId,
          eventId: event.eventId,
          status: 'AWAITING_PAYMENT',
          totalMinor,
          currency: event.currency,
          expiresAt,
        });
        await transaction.insert(bookingItems).values(
          heldSeats.map((seat) => ({
            bookingId,
            eventId: event.eventId,
            seatId: seat.seatId,
            priceMinor: seat.priceMinor,
          })),
        );
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'booking.created',
            {
              bookingId,
              userId,
              eventId: event.eventId,
              seatIds,
              amountMinor: totalMinor,
              currency: event.currency.trim(),
              expiresAt: expiresAt.toISOString(),
            },
            { correlationId: getCorrelationId() ?? randomUUID() },
          ),
        );
        await transaction.insert(idempotencyKeys).values({
          userId,
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody,
        });
        return responseBody;
      });
      this.metrics?.bookingHolds.inc({ result: 'success' });
      return response;
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.status === 409) {
          this.metrics?.bookingHolds.inc({ result: 'conflict' });
        } else if (error.status === 400 || error.status === 422) {
          this.metrics?.bookingHolds.inc({ result: 'invalid' });
        }
      }
      if (!(error instanceof DomainError)) {
        const failure =
          error && typeof error === 'object'
            ? (error as {
                code?: unknown;
                constraint?: unknown;
                name?: unknown;
                message?: unknown;
              })
            : {};
        this.logger.error(
          `Hold transaction failed: name=${logValue(failure.name)} code=${logValue(failure.code)} constraint=${logValue(failure.constraint)} message=${logValue(failure.message)}`,
        );
      }
      throw error;
    }
  }

  async listBookings(
    userId: string,
    limitInput?: string,
    offsetInput?: string,
  ) {
    const ownerId = parseUuid(userId);
    const limit = parsePageValue(limitInput, 20, 100);
    const offset = parsePageValue(offsetInput, 0, Number.MAX_SAFE_INTEGER);
    return this.database
      .select()
      .from(bookings)
      .where(eq(bookings.userId, ownerId))
      .orderBy(sql`${bookings.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
  }

  async getBooking(userId: string, bookingId: string) {
    const ownerId = parseUuid(userId);
    const id = parseUuid(bookingId);
    const [booking] = await this.database
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.userId, ownerId)))
      .limit(1);
    if (!booking)
      throw new DomainError('Booking not found', 'BOOKING_NOT_FOUND', 404);
    const items = await this.database
      .select()
      .from(bookingItems)
      .where(eq(bookingItems.bookingId, id));
    return { ...booking, items };
  }

  async listTickets(userId: string) {
    const ownerId = parseUuid(userId);
    const qrSecret = getQrSecret();
    const ownerTickets = await this.database
      .select({
        id: tickets.id,
        bookingId: tickets.bookingId,
        eventId: tickets.eventId,
        seatId: tickets.seatId,
        status: tickets.status,
        issuedAt: tickets.issuedAt,
        usedAt: tickets.usedAt,
        eventTitle: eventSnapshots.title,
        startsAt: eventSnapshots.startsAt,
      })
      .from(tickets)
      .innerJoin(eventSnapshots, eq(tickets.eventId, eventSnapshots.eventId))
      .where(eq(tickets.userId, ownerId))
      .orderBy(desc(tickets.issuedAt));
    return ownerTickets.map((ticket) => ({
      ...ticket,
      qrToken: createTicketQrToken(ticket.id, qrSecret),
    }));
  }

  async getTicket(userId: string, ticketId: string) {
    const ownerId = parseUuid(userId);
    const id = parseUuid(ticketId);
    const [ticket] = await this.database
      .select({
        id: tickets.id,
        bookingId: tickets.bookingId,
        eventId: tickets.eventId,
        seatId: tickets.seatId,
        status: tickets.status,
        issuedAt: tickets.issuedAt,
        usedAt: tickets.usedAt,
        eventTitle: eventSnapshots.title,
        startsAt: eventSnapshots.startsAt,
      })
      .from(tickets)
      .innerJoin(eventSnapshots, eq(tickets.eventId, eventSnapshots.eventId))
      .where(and(eq(tickets.id, id), eq(tickets.userId, ownerId)))
      .limit(1);
    if (!ticket)
      throw new DomainError('Ticket not found', 'TICKET_NOT_FOUND', 404);
    return {
      ...ticket,
      qrToken: createTicketQrToken(ticket.id, getQrSecret()),
    };
  }

  async checkIn(organizerId: string, input: unknown) {
    const ownerId = parseUuid(organizerId);
    const parsed = checkInSchema.safeParse(input);
    if (!parsed.success) throw invalidTicketToken();
    const ticketId = verifyTicketQrToken(parsed.data.token, getQrSecret());
    if (!ticketId) throw invalidTicketToken();

    return this.database.transaction(async (transaction) => {
      const [ticket] = await transaction
        .select({
          id: tickets.id,
          eventId: tickets.eventId,
          seatId: tickets.seatId,
          organizerId: eventSnapshots.organizerId,
        })
        .from(tickets)
        .innerJoin(eventSnapshots, eq(tickets.eventId, eventSnapshots.eventId))
        .where(eq(tickets.id, ticketId))
        .limit(1);
      if (!ticket) throw invalidTicketToken();
      if (ticket.organizerId !== ownerId) {
        throw new DomainError(
          'Event is owned by another organizer',
          'EVENT_FORBIDDEN',
          403,
        );
      }

      const [usedTicket] = await transaction
        .update(tickets)
        .set({ status: 'USED', usedAt: sql`now()` })
        .where(and(eq(tickets.id, ticketId), eq(tickets.status, 'VALID')))
        .returning({
          id: tickets.id,
          eventId: tickets.eventId,
          seatId: tickets.seatId,
          status: tickets.status,
          usedAt: tickets.usedAt,
        });
      if (usedTicket) return usedTicket;

      const [currentTicket] = await transaction
        .select({ status: tickets.status, usedAt: tickets.usedAt })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update')
        .limit(1);
      if (!currentTicket) throw invalidTicketToken();
      if (currentTicket.status === 'USED') {
        throw new DomainError(
          'Ticket has already been used',
          'TICKET_ALREADY_USED',
          409,
          {
            usedAt: currentTicket.usedAt?.toISOString() ?? null,
          },
        );
      }
      if (currentTicket.status === 'VOID') {
        throw new DomainError('Ticket is void', 'TICKET_VOID', 410);
      }
      throw new Error(`Ticket ${ticketId} could not be checked in`);
    });
  }

  async cancelBooking(userId: string, bookingId: string) {
    const ownerId = parseUuid(userId);
    const id = parseUuid(bookingId);
    return this.database.transaction(async (transaction) => {
      const [booking] = await transaction
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.userId, ownerId)))
        .for('update')
        .limit(1);
      if (!booking)
        throw new DomainError('Booking not found', 'BOOKING_NOT_FOUND', 404);
      if (booking.status === 'CANCELLED') return booking;
      const confirmed = booking.status === 'CONFIRMED';
      if (booking.status !== 'AWAITING_PAYMENT' && !confirmed) {
        throw new DomainError(
          'Booking cannot be cancelled',
          'BOOKING_NOT_CANCELLABLE',
          409,
        );
      }
      if (confirmed) {
        const [event] = await transaction
          .select({
            withinCancellationWindow: sql<boolean>`${eventSnapshots.startsAt} > now() + interval '24 hours'`,
          })
          .from(eventSnapshots)
          .where(eq(eventSnapshots.eventId, booking.eventId))
          .limit(1);
        if (!event?.withinCancellationWindow) {
          throw new DomainError(
            'Confirmed bookings can only be cancelled more than 24 hours before the event',
            'CANCELLATION_WINDOW_CLOSED',
            409,
          );
        }
        if (!booking.paymentId)
          throw new Error(`Confirmed booking ${booking.id} has no payment ID`);
      }

      const [cancelled] = await transaction
        .update(bookings)
        .set({
          status: BookingStateMachine.transition(booking.status, 'CANCELLED'),
          cancelReason: 'USER_CANCELLED',
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, id))
        .returning();
      if (!cancelled) throw new Error('Booking cancellation returned no row');
      this.metrics?.bookingStateTransitions.inc({
        from: booking.status,
        to: 'CANCELLED',
      });

      if (confirmed) {
        await transaction
          .update(tickets)
          .set({ status: 'VOID' })
          .where(eq(tickets.bookingId, id));
      }
      await transaction
        .update(seats)
        .set({
          status: 'AVAILABLE',
          bookingId: null,
          heldUntil: null,
          version: sql`${seats.version} + 1`,
        })
        .where(
          and(
            eq(seats.bookingId, id),
            eq(seats.status, confirmed ? 'SOLD' : 'HELD'),
          ),
        );
      await this.outbox.write(
        transaction,
        makeEnvelope(
          'booking.cancelled',
          {
            bookingId: booking.id,
            userId: ownerId,
            eventId: booking.eventId,
            reason: 'USER_CANCELLED',
          },
          { correlationId: getCorrelationId() ?? randomUUID() },
        ),
      );
      if (confirmed && booking.paymentId) {
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'refund.requested',
            {
              bookingId: booking.id,
              paymentRef: booking.paymentId,
              reason: 'USER_CANCELLED',
            },
            { correlationId: getCorrelationId() ?? randomUUID() },
          ),
        );
      }
      return cancelled;
    });
  }

  private scheduleExpirySweep(): void {
    void this.sweepExpiredBookings().catch((error: unknown) => {
      this.logger.error(
        'Hold expiry sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  private async expireBookingBatch(): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const expiredBookings = await transaction
        .select({
          id: bookings.id,
          userId: bookings.userId,
          eventId: bookings.eventId,
          status: bookings.status,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.status, 'AWAITING_PAYMENT'),
            sql`${bookings.expiresAt} < now()`,
          ),
        )
        .orderBy(asc(bookings.expiresAt))
        .limit(100)
        .for('update', { skipLocked: true });

      let expiredCount = 0;
      for (const booking of expiredBookings) {
        const [expired] = await transaction
          .update(bookings)
          .set({
            status: BookingStateMachine.transition(booking.status, 'EXPIRED'),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(bookings.id, booking.id),
              eq(bookings.status, 'AWAITING_PAYMENT'),
            ),
          )
          .returning({ id: bookings.id });
        if (!expired) continue;
        this.metrics?.bookingStateTransitions.inc({
          from: booking.status,
          to: 'EXPIRED',
        });

        await transaction
          .update(seats)
          .set({
            status: 'AVAILABLE',
            bookingId: null,
            heldUntil: null,
            version: sql`${seats.version} + 1`,
          })
          .where(
            and(eq(seats.bookingId, booking.id), eq(seats.status, 'HELD')),
          );
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'booking.expired',
            {
              bookingId: booking.id,
              userId: booking.userId,
              eventId: booking.eventId,
            },
            { correlationId: randomUUID() },
          ),
        );
        expiredCount += 1;
      }

      return expiredCount;
    });
  }
}

export function createBookingPool(): Pool {
  const connectionString =
    process.env.BOOKING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('BOOKING_DATABASE_URL is required');
  return createPgPool({ connectionString });
}

export function createBookingDatabase(pool: Pool): DrizzleDatabase {
  return createDrizzle(pool);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function logValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : 'unknown';
}

function parsePageValue(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new DomainError('Invalid pagination value', 'VALIDATION_FAILED', 422);
  }
  return parsed;
}

function parseUuid(value: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new DomainError('Invalid ID', 'VALIDATION_FAILED', 422);
  }
  return value;
}

function getQrSecret(): string {
  const secret = process.env.QR_SECRET;
  if (!secret) throw new Error('QR_SECRET is required for ticket operations');
  return secret;
}

function invalidTicketToken(): DomainError {
  return new DomainError('Ticket token is invalid', 'TICKET_INVALID', 422);
}
