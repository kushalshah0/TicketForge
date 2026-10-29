import { randomUUID } from 'node:crypto';
import { eventSchemas, makeEnvelope, parseEvent, routingKeys } from './events';

const appendixBTypes = [
  'user.registered',
  'event.published',
  'event.updated',
  'event.cancelled',
  'booking.created',
  'payment.succeeded',
  'payment.failed',
  'booking.confirmed',
  'booking.cancelled',
  'booking.expired',
  'refund.requested',
  'payment.refunded',
] as const;

describe('event catalog', () => {
  it('has a schema and routing key for every Appendix B event', () => {
    expect(Object.keys(eventSchemas).sort()).toEqual(
      [...appendixBTypes].sort(),
    );
    expect(Object.keys(routingKeys).sort()).toEqual([...appendixBTypes].sort());
    expect(Object.values(routingKeys)).toEqual(
      expect.arrayContaining(appendixBTypes),
    );
  });

  it('creates a version 1 envelope and validates its payload', () => {
    const envelope = makeEnvelope(
      'user.registered',
      {
        userId: randomUUID(),
        email: 'user@example.test',
        displayName: 'Ticket User',
        role: 'customer',
      },
      { correlationId: randomUUID() },
    );

    expect(envelope.version).toBe(1);
    expect(envelope.producer).toBe('auth-service');
    expect(parseEvent(envelope.type, envelope)).toEqual(envelope);
  });

  it('rejects an invalid event payload', () => {
    expect(() =>
      makeEnvelope(
        'payment.failed',
        {
          paymentId: 'not-a-uuid',
          bookingId: randomUUID(),
          reason: 'declined',
        },
        { correlationId: randomUUID() },
      ),
    ).toThrow();
  });

  it('requires currency in a payment.refunded event', () => {
    const event = makeEnvelope(
      'payment.refunded',
      {
        paymentId: randomUUID(),
        bookingId: randomUUID(),
        userId: randomUUID(),
        amountMinor: 4_200,
        currency: 'NPR',
        reason: 'EVENT_CANCELLED',
      },
      { correlationId: randomUUID() },
    );

    expect(parseEvent(event.type, event)).toEqual(event);
  });
});
