import { jest } from '@jest/globals';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  it('atomically increments a namespaced key and returns throttler timing in seconds', async () => {
    const evalScript = jest
      .fn<Redis['eval']>()
      .mockResolvedValue([21, 12_000, 1, 8_000]);
    const storage = new RedisThrottlerStorage();
    Object.defineProperty(storage, 'redis', { value: { eval: evalScript } });

    await expect(
      storage.increment('client-key', 60_000, 20, 30_000, 'bookings'),
    ).resolves.toEqual({
      totalHits: 21,
      timeToExpire: 12,
      isBlocked: true,
      timeToBlockExpire: 8,
    });
    expect(evalScript.mock.calls[0]?.slice(1)).toEqual([
      1,
      'client-key:bookings',
      60_000,
      20,
      30_000,
    ]);
  });
});
