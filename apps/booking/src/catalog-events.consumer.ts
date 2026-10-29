import {
  Inject,
  Injectable,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { OutboxService } from '@tf/outbox';
import { MessagingService } from '@tf/messaging';
import { makeEnvelope } from '@tf/contracts';
import {
  MetricsService,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '@tf/common';
import { type EventEnvelope } from '@tf/contracts';
import { BookingStateMachine } from './booking-state-machine';
import { BOOKING_DATABASE } from './booking.service';
import { bookings, eventSnapshots, seats, tickets } from './database/schema';

@Injectable()
export class CatalogEventsConsumer implements OnModuleInit {
  constructor(
    private readonly messaging: MessagingService,
    @Inject(BOOKING_DATABASE) private readonly database: DrizzleDatabase,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onModuleInit(queue = 'booking.catalog-events'): Promise<void> {
    await this.messaging.consume(
      queue,
      (envelope, transaction) => this.handle(envelope, transaction),
      { database: this.database, consumer: 'booking.catalog-events' },
    );
  }

  async handle(
    envelope: EventEnvelope,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    if (envelope.type === 'event.published') {
      const { data } = envelope;
      const [snapshot] = await transaction
        .insert(eventSnapshots)
        .values({
          eventId: data.eventId,
          organizerId: data.organizerId,
          title: data.title,
          startsAt: new Date(data.startsAt),
          status: 'PUBLISHED',
          currency: data.currency,
        })
        .onConflictDoNothing({ target: eventSnapshots.eventId })
        .returning({ eventId: eventSnapshots.eventId });
      if (!snapshot) return;

      const prices = new Map(
        data.tiers.map((tier) => [tier.id, tier.priceMinor]),
      );
      const inventory = data.layout.sections.flatMap((section) => {
        const priceMinor = prices.get(section.tierId);
        if (priceMinor === undefined)
          throw new Error(`Missing price for tier ${section.tierId}`);
        return Array.from(
          { length: section.rows * section.seatsPerRow },
          (_, index) => {
            const row = String.fromCharCode(
              65 + Math.floor(index / section.seatsPerRow),
            );
            const seatNumber = (index % section.seatsPerRow) + 1;
            return {
              eventId: data.eventId,
              seatId: `${section.id}-${row}${seatNumber}`,
              sectionId: section.id,
              tierId: section.tierId,
              priceMinor,
              status: 'AVAILABLE' as const,
            };
          },
        );
      });
      for (let offset = 0; offset < inventory.length; offset += 250) {
        await transaction
          .insert(seats)
          .values(inventory.slice(offset, offset + 250))
          .onConflictDoNothing();
      }
      return;
    }

    if (envelope.type === 'event.updated') {
      await transaction
        .update(eventSnapshots)
        .set({
          title: envelope.data.title,
          startsAt: new Date(envelope.data.startsAt),
          updatedAt: new Date(),
        })
        .where(eq(eventSnapshots.eventId, envelope.data.eventId));
      return;
    }

    if (envelope.type === 'event.cancelled') {
      await transaction
        .update(eventSnapshots)
        .set({ status: 'CANCELLED', updatedAt: sql`now()` })
        .where(eq(eventSnapshots.eventId, envelope.data.eventId));
      await this.cancelEventBookings(envelope, transaction);
    }
  }

  private async cancelEventBookings(
    envelope: Extract<EventEnvelope, { type: 'event.cancelled' }>,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    while (true) {
      const activeBookings = await transaction
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.eventId, envelope.data.eventId),
            inArray(bookings.status, ['AWAITING_PAYMENT', 'CONFIRMED']),
          ),
        )
        .orderBy(asc(bookings.id))
        .limit(100)
        .for('update');
      if (activeBookings.length === 0) break;

      for (const booking of activeBookings) {
        const confirmed = booking.status === 'CONFIRMED';
        if (confirmed && !booking.paymentId) {
          throw new Error(`Confirmed booking ${booking.id} has no payment ID`);
        }
        await transaction
          .update(bookings)
          .set({
            status: BookingStateMachine.transition(booking.status, 'CANCELLED'),
            cancelReason: 'EVENT_CANCELLED',
            updatedAt: sql`now()`,
          })
          .where(eq(bookings.id, booking.id));
        this.metrics?.bookingStateTransitions.inc({
          from: booking.status,
          to: 'CANCELLED',
        });
        if (confirmed) {
          await transaction
            .update(tickets)
            .set({ status: 'VOID' })
            .where(eq(tickets.bookingId, booking.id));
        }
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'booking.cancelled',
            {
              bookingId: booking.id,
              userId: booking.userId,
              eventId: booking.eventId,
              reason: 'EVENT_CANCELLED',
            },
            { correlationId: envelope.correlationId, causationId: envelope.id },
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
                reason: 'EVENT_CANCELLED',
              },
              {
                correlationId: envelope.correlationId,
                causationId: envelope.id,
              },
            ),
          );
        }
      }
    }

    await transaction
      .update(seats)
      .set({
        status: 'BLOCKED',
        bookingId: null,
        heldUntil: null,
        version: sql`${seats.version} + 1`,
      })
      .where(
        and(
          eq(seats.eventId, envelope.data.eventId),
          ne(seats.status, 'BLOCKED'),
        ),
      );
  }
}
