import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  MetricsService,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '@tf/common';
import { Optional } from '@nestjs/common';
import { makeEnvelope, type EventEnvelope } from '@tf/contracts';
import { MessagingService } from '@tf/messaging';
import { OutboxService } from '@tf/outbox';
import { BOOKING_DATABASE } from './booking.service';
import { BookingStateMachine } from './booking-state-machine';
import {
  bookingItems,
  bookings,
  eventSnapshots,
  seats,
  tickets,
} from './database/schema';
import { createTicketQrToken } from './ticket-qr';

@Injectable()
export class PaymentEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly messaging: MessagingService,
    @Inject(BOOKING_DATABASE) private readonly database: DrizzleDatabase,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onModuleInit(queue = 'booking.payment-events'): Promise<void> {
    await this.messaging.consume(
      queue,
      (envelope, transaction) => this.handle(envelope, transaction),
      { database: this.database, consumer: 'booking.payment-events' },
    );
  }

  async handle(
    envelope: EventEnvelope,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    if (envelope.type === 'payment.succeeded') {
      await this.handleSuccess(envelope, transaction);
    } else if (envelope.type === 'payment.failed') {
      await this.handleFailure(envelope, transaction);
    }
  }

  private async handleSuccess(
    envelope: Extract<EventEnvelope, { type: 'payment.succeeded' }>,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    const { bookingId } = envelope.data;
    const [booking] = await transaction
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for('update')
      .limit(1);
    if (!booking)
      throw new Error(`Payment succeeded for missing booking ${bookingId}`);
    if (booking.status === 'CONFIRMED') return;

    const items = await transaction
      .select()
      .from(bookingItems)
      .where(eq(bookingItems.bookingId, booking.id))
      .orderBy(asc(bookingItems.seatId));
    if (items.length === 0)
      throw new Error(`Booking ${booking.id} has no items`);
    const eventSeats = await transaction
      .select()
      .from(seats)
      .where(
        and(
          eq(seats.eventId, booking.eventId),
          inArray(
            seats.seatId,
            items.map((item) => item.seatId),
          ),
        ),
      )
      .orderBy(asc(seats.seatId))
      .for('update');
    const ownsAllSeats =
      eventSeats.length === items.length &&
      eventSeats.every(
        (seat) => seat.status === 'HELD' && seat.bookingId === booking.id,
      );

    if (booking.status !== 'AWAITING_PAYMENT' || !ownsAllSeats) {
      if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') {
        await this.writeRefundRequest(transaction, envelope, 'LATE_PAYMENT');
      } else if (booking.status === 'AWAITING_PAYMENT') {
        await this.writeRefundRequest(transaction, envelope, 'SEAT_LOST');
      }
      return;
    }

    const [event] = await transaction
      .select({
        title: eventSnapshots.title,
        startsAt: eventSnapshots.startsAt,
      })
      .from(eventSnapshots)
      .where(eq(eventSnapshots.eventId, booking.eventId))
      .limit(1);
    if (!event)
      throw new Error(`Event snapshot missing for booking ${booking.id}`);
    const qrSecret = process.env.QR_SECRET;
    if (!qrSecret) throw new Error('QR_SECRET is required to confirm bookings');

    const issuedTickets = items.map((item) => {
      const ticketId = randomUUID();
      return {
        ticket: {
          id: ticketId,
          bookingId: booking.id,
          eventId: item.eventId,
          seatId: item.seatId,
          userId: booking.userId,
        },
        ticketId,
        seatId: item.seatId,
        qrToken: createTicketQrToken(ticketId, qrSecret),
      };
    });

    await transaction
      .update(bookings)
      .set({
        status: BookingStateMachine.transition(booking.status, 'CONFIRMED'),
        paymentId: envelope.data.paymentId,
        confirmedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bookings.id, booking.id),
          eq(bookings.status, 'AWAITING_PAYMENT'),
        ),
      );
    this.metrics?.bookingStateTransitions.inc({
      from: booking.status,
      to: 'CONFIRMED',
    });
    await transaction
      .update(seats)
      .set({
        status: 'SOLD',
        heldUntil: null,
        version: sql`${seats.version} + 1`,
      })
      .where(and(eq(seats.bookingId, booking.id), eq(seats.status, 'HELD')));
    await transaction
      .insert(tickets)
      .values(issuedTickets.map(({ ticket }) => ticket));
    await this.outbox.write(
      transaction,
      makeEnvelope(
        'booking.confirmed',
        {
          bookingId: booking.id,
          userId: booking.userId,
          eventTitle: event.title,
          startsAt: event.startsAt.toISOString(),
          totalMinor: booking.totalMinor,
          currency: booking.currency.trim(),
          tickets: issuedTickets.map(({ ticketId, seatId, qrToken }) => ({
            ticketId,
            seatId,
            qrToken,
          })),
        },
        { correlationId: envelope.correlationId, causationId: envelope.id },
      ),
    );
  }

  private async handleFailure(
    envelope: Extract<EventEnvelope, { type: 'payment.failed' }>,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    const [booking] = await transaction
      .select()
      .from(bookings)
      .where(eq(bookings.id, envelope.data.bookingId))
      .for('update')
      .limit(1);
    if (!booking)
      throw new Error(
        `Payment failed for missing booking ${envelope.data.bookingId}`,
      );
    if (booking.status !== 'AWAITING_PAYMENT') return;

    await transaction
      .update(bookings)
      .set({
        status: BookingStateMachine.transition(booking.status, 'CANCELLED'),
        cancelReason: 'PAYMENT_FAILED',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bookings.id, booking.id),
          eq(bookings.status, 'AWAITING_PAYMENT'),
        ),
      );
    this.metrics?.bookingStateTransitions.inc({
      from: booking.status,
      to: 'CANCELLED',
    });
    await transaction
      .update(seats)
      .set({
        status: 'AVAILABLE',
        bookingId: null,
        heldUntil: null,
        version: sql`${seats.version} + 1`,
      })
      .where(and(eq(seats.bookingId, booking.id), eq(seats.status, 'HELD')));
    await this.outbox.write(
      transaction,
      makeEnvelope(
        'booking.cancelled',
        {
          bookingId: booking.id,
          userId: booking.userId,
          eventId: booking.eventId,
          reason: 'PAYMENT_FAILED',
        },
        { correlationId: envelope.correlationId, causationId: envelope.id },
      ),
    );
  }

  private async writeRefundRequest(
    transaction: DrizzleTransaction,
    envelope: Extract<EventEnvelope, { type: 'payment.succeeded' }>,
    reason: 'LATE_PAYMENT' | 'SEAT_LOST',
  ): Promise<void> {
    await this.outbox.write(
      transaction,
      makeEnvelope(
        'refund.requested',
        {
          bookingId: envelope.data.bookingId,
          paymentRef: envelope.data.paymentId,
          reason,
        },
        { correlationId: envelope.correlationId, causationId: envelope.id },
      ),
    );
    this.logger.warn(
      `Refund requested for booking ${envelope.data.bookingId}: ${reason}`,
    );
  }
}
