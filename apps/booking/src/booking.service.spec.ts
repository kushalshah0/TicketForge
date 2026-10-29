import { MetricsService, type DrizzleDatabase } from '@tf/common';
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
});
