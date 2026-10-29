import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const currency = z.string().regex(/^[A-Z]{3}$/);
const amountMinor = z.number().int().nonnegative();

export const eventDataSchemas = {
  'user.registered': z.object({
    userId: uuid,
    email: z.string().email(),
    displayName: z.string().min(1),
    role: z.enum(['customer', 'organizer']),
  }),
  'event.published': z.object({
    eventId: uuid,
    organizerId: uuid,
    title: z.string().min(1),
    startsAt: timestamp,
    venueName: z.string().min(1),
    city: z.string().min(1),
    currency,
    tiers: z.array(
      z.object({
        id: uuid,
        name: z.string().min(1),
        priceMinor: amountMinor,
      }),
    ),
    layout: z.object({
      sections: z.array(
        z.object({
          id: uuid,
          name: z.string().min(1),
          tierId: uuid,
          rows: z.number().int().positive(),
          seatsPerRow: z.number().int().positive(),
        }),
      ),
    }),
  }),
  'event.updated': z.object({
    eventId: uuid,
    title: z.string().min(1),
    startsAt: timestamp,
  }),
  'event.cancelled': z.object({
    eventId: uuid,
    reason: z.string().min(1),
  }),
  'booking.created': z.object({
    bookingId: uuid,
    userId: uuid,
    eventId: uuid,
    seatIds: z.array(z.string().min(1)).min(1),
    amountMinor,
    currency,
    expiresAt: timestamp,
  }),
  'payment.succeeded': z.object({
    paymentId: uuid,
    bookingId: uuid,
    amountMinor,
    providerRef: z.string().min(1),
  }),
  'payment.failed': z.object({
    paymentId: uuid,
    bookingId: uuid,
    reason: z.string().min(1),
  }),
  'booking.confirmed': z.object({
    bookingId: uuid,
    userId: uuid,
    eventTitle: z.string().min(1),
    startsAt: timestamp,
    totalMinor: amountMinor,
    currency,
    tickets: z.array(
      z.object({
        ticketId: uuid,
        seatId: z.string().min(1),
        qrToken: z.string().min(1),
      }),
    ),
  }),
  'booking.cancelled': z.object({
    bookingId: uuid,
    userId: uuid,
    eventId: uuid,
    reason: z.enum(['PAYMENT_FAILED', 'USER_CANCELLED', 'EVENT_CANCELLED']),
  }),
  'booking.expired': z.object({
    bookingId: uuid,
    userId: uuid,
    eventId: uuid,
  }),
  'refund.requested': z.object({
    bookingId: uuid,
    paymentRef: uuid,
    reason: z.enum([
      'LATE_PAYMENT',
      'SEAT_LOST',
      'USER_CANCELLED',
      'EVENT_CANCELLED',
    ]),
  }),
  'payment.refunded': z.object({
    paymentId: uuid,
    bookingId: uuid,
    userId: uuid,
    amountMinor,
    currency: currency.optional(),
    reason: z.string().min(1),
  }),
} as const;

export type EventType = keyof typeof eventDataSchemas;
export type EventProducer =
  'auth-service' | 'catalog-service' | 'booking-service' | 'payment-service';

const eventProducers: Record<EventType, EventProducer> = {
  'user.registered': 'auth-service',
  'event.published': 'catalog-service',
  'event.updated': 'catalog-service',
  'event.cancelled': 'catalog-service',
  'booking.created': 'booking-service',
  'payment.succeeded': 'payment-service',
  'payment.failed': 'payment-service',
  'booking.confirmed': 'booking-service',
  'booking.cancelled': 'booking-service',
  'booking.expired': 'booking-service',
  'refund.requested': 'booking-service',
  'payment.refunded': 'payment-service',
};

const envelopeFields = {
  id: uuid,
  version: z.literal(1),
  occurredAt: timestamp,
  correlationId: z.string().min(1),
  causationId: uuid.nullable(),
};

function defineEvent<TType extends EventType>(type: TType) {
  return z.object({
    ...envelopeFields,
    type: z.literal(type),
    producer: z.literal(eventProducers[type]),
    data: eventDataSchemas[type],
  });
}

export const eventSchemas = {
  'user.registered': defineEvent('user.registered'),
  'event.published': defineEvent('event.published'),
  'event.updated': defineEvent('event.updated'),
  'event.cancelled': defineEvent('event.cancelled'),
  'booking.created': defineEvent('booking.created'),
  'payment.succeeded': defineEvent('payment.succeeded'),
  'payment.failed': defineEvent('payment.failed'),
  'booking.confirmed': defineEvent('booking.confirmed'),
  'booking.cancelled': defineEvent('booking.cancelled'),
  'booking.expired': defineEvent('booking.expired'),
  'refund.requested': defineEvent('refund.requested'),
  'payment.refunded': defineEvent('payment.refunded'),
} as const;

export type EventEnvelope<TType extends EventType = EventType> = z.infer<
  (typeof eventSchemas)[TType]
>;

export const routingKeys: Record<EventType, EventType> = {
  'user.registered': 'user.registered',
  'event.published': 'event.published',
  'event.updated': 'event.updated',
  'event.cancelled': 'event.cancelled',
  'booking.created': 'booking.created',
  'payment.succeeded': 'payment.succeeded',
  'payment.failed': 'payment.failed',
  'booking.confirmed': 'booking.confirmed',
  'booking.cancelled': 'booking.cancelled',
  'booking.expired': 'booking.expired',
  'refund.requested': 'refund.requested',
  'payment.refunded': 'payment.refunded',
};

export interface EnvelopeContext {
  correlationId: string;
  causationId?: string | null;
  id?: string;
  occurredAt?: Date;
}

export function makeEnvelope<TType extends EventType>(
  type: TType,
  data: z.input<(typeof eventDataSchemas)[TType]>,
  context: EnvelopeContext,
): EventEnvelope<TType> {
  return eventSchemas[type].parse({
    id: context.id ?? randomUUID(),
    type,
    version: 1,
    occurredAt: (context.occurredAt ?? new Date()).toISOString(),
    correlationId: context.correlationId,
    causationId: context.causationId ?? null,
    producer: eventProducers[type],
    data,
  }) as EventEnvelope<TType>;
}

export function parseEvent(type: string, payload: unknown): EventEnvelope {
  if (!Object.hasOwn(eventSchemas, type))
    throw new Error(`Unknown event type: ${type}`);
  return eventSchemas[type as EventType].parse(payload);
}
