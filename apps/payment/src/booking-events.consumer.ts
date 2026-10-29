import {
  Inject,
  Injectable,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { MessagingService } from '@tf/messaging';
import {
  MetricsService,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '@tf/common';
import { makeEnvelope, type EventEnvelope } from '@tf/contracts';
import { and, count, eq, sql } from 'drizzle-orm';
import { Gauge } from 'prom-client';
import { OutboxService } from '@tf/outbox';
import { PAYMENT_DATABASE } from './payment.service';
import { payments, refunds } from './database/schema';

@Injectable()
export class BookingEventsConsumer implements OnModuleInit {
  constructor(
    private readonly messaging: MessagingService,
    @Inject(PAYMENT_DATABASE) private readonly database: DrizzleDatabase,
    private readonly outbox: OutboxService,
    @Optional() metrics?: MetricsService,
  ) {
    if (metrics) {
      new Gauge({
        name: 'payment_refunds',
        help: 'Number of committed refunds in the payment database',
        registers: [metrics.registry],
        async collect() {
          const [result] = await database
            .select({ value: count() })
            .from(refunds);
          if (!result) throw new Error('Missing refund count');
          this.set(result.value);
        },
      });
    }
  }

  async onModuleInit(queue = 'payment.booking-events'): Promise<void> {
    await this.messaging.consume(
      queue,
      (envelope, transaction) => this.handle(envelope, transaction),
      { database: this.database, consumer: 'payment.booking-events' },
    );
  }

  private async handle(
    envelope: EventEnvelope,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    if (envelope.type === 'booking.created') {
      const { bookingId, userId, amountMinor, currency, expiresAt } =
        envelope.data;
      await transaction
        .insert(payments)
        .values({
          bookingId,
          userId,
          amountMinor,
          currency,
          status: 'PENDING',
          expiresAt: new Date(expiresAt),
        })
        .onConflictDoNothing({ target: payments.bookingId });
      return;
    }

    if (
      envelope.type === 'booking.expired' ||
      envelope.type === 'booking.cancelled'
    ) {
      await transaction
        .update(payments)
        .set({ status: 'CANCELLED', updatedAt: sql`now()` })
        .where(
          and(
            eq(payments.bookingId, envelope.data.bookingId),
            eq(payments.status, 'PENDING'),
          ),
        );
      return;
    }

    if (envelope.type !== 'refund.requested') return;

    const [payment] = await transaction
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.id, envelope.data.paymentRef),
          eq(payments.bookingId, envelope.data.bookingId),
        ),
      )
      .for('update')
      .limit(1);
    if (!payment)
      throw new Error(
        `Refund requested for missing payment ${envelope.data.paymentRef}`,
      );
    if (payment.status === 'REFUNDED') return;
    if (payment.status !== 'SUCCEEDED') {
      throw new Error(
        `Cannot refund payment ${payment.id} in ${payment.status}`,
      );
    }

    const [refund] = await transaction
      .insert(refunds)
      .values({
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        reason: envelope.data.reason,
      })
      .onConflictDoNothing({ target: refunds.paymentId })
      .returning({ id: refunds.id });
    if (!refund) return;

    await transaction
      .update(payments)
      .set({ status: 'REFUNDED', updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));
    await this.outbox.write(
      transaction,
      makeEnvelope(
        'payment.refunded',
        {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          userId: payment.userId,
          amountMinor: payment.amountMinor,
          currency: payment.currency.trim(),
          reason: envelope.data.reason,
        },
        { correlationId: envelope.correlationId, causationId: envelope.id },
      ),
    );
  }
}
