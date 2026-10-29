import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

const incrementScript = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local timeToExpire = redis.call('PTTL', KEYS[1])
local blockKey = KEYS[1] .. ':blocked'
local timeToBlockExpire = redis.call('PTTL', blockKey)
if hits > tonumber(ARGV[2]) and timeToBlockExpire <= 0 and tonumber(ARGV[3]) > 0 then
  redis.call('SET', blockKey, '1', 'PX', ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  timeToBlockExpire = tonumber(ARGV[3])
end
return { hits, math.max(timeToExpire, 0), timeToBlockExpire > 0 and 1 or 0, math.max(timeToBlockExpire, 0) }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis = new Redis(
    process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    },
  );

  constructor() {
    this.redis.on('error', (error: Error) =>
      this.logger.error(
        `Redis rate-limit storage unavailable: ${error.message}`,
      ),
    );
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] =
      (await this.redis.eval(
        incrementScript,
        1,
        `${key}:${throttlerName}`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpire / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(timeToBlockExpire / 1000),
    };
  }

  onApplicationShutdown(): void {
    if (this.redis.status === 'ready') {
      void this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
