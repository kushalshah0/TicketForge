import { DomainError, MetricsService, type DrizzleDatabase } from '@tf/common';
import type { Pool } from 'pg';
import { OutboxService } from '@tf/outbox';
import { BookingService } from './booking.service';

describe('BookingService metrics', () => {
  it('counts invalid hold requests', async () => {
    const metrics = new MetricsService();
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
      metrics,
    );

    await expect(
      service.createHold('user-id', undefined, {}),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });

    const metric = await metrics.bookingHolds.get();
    expect(metric.values).toContainEqual(
      expect.objectContaining({ labels: { result: 'invalid' }, value: 1 }),
    );
  });

  it('rejects invalid users and malformed hold requests before database access', async () => {
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
    );
    const eventId = 'c0a80123-4567-489a-8abc-123456789abc';

    await expect(
      service.createHold('not-a-uuid', 'valid-key', {
        eventId,
        seatIds: ['A1'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await expect(
      service.createHold('c0a80123-4567-489a-8abc-123456789abd', 'valid-key', {
        eventId,
        seatIds: ['A1', 'A1'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.createHold('c0a80123-4567-489a-8abc-123456789abd', 'valid-key', {
        eventId,
        seatIds: Array.from({ length: 7 }, (_, index) => `A${index}`),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects invalid availability IDs before database access', async () => {
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
    );

    await expect(service.getAvailability('invalid')).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('rejects invalid booking IDs and pagination before database access', async () => {
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
    );
    const userId = 'c0a80123-4567-489a-8abc-123456789abc';

    await expect(service.getBooking(userId, 'invalid')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.listBookings(userId, '101')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      service.listBookings(userId, undefined, '-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects malformed ticket check-in requests before database access', async () => {
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
    );

    await expect(
      service.checkIn('c0a80123-4567-489a-8abc-123456789abc', {}),
    ).rejects.toMatchObject({ code: 'TICKET_INVALID' });
  });

  it('requires a QR secret before listing tickets', async () => {
    const service = new BookingService(
      {} as Pool,
      {} as DrizzleDatabase,
      {} as OutboxService,
    );
    const previousQrSecret = process.env.QR_SECRET;
    delete process.env.QR_SECRET;

    try {
      await expect(
        service.listTickets('c0a80123-4567-489a-8abc-123456789abc'),
      ).rejects.toThrow('QR_SECRET is required for ticket operations');
    } finally {
      if (previousQrSecret === undefined) delete process.env.QR_SECRET;
      else process.env.QR_SECRET = previousQrSecret;
    }
  });
});
