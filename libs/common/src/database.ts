import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

const logger = new Logger('PostgresPool');

export type DrizzleDatabase = ReturnType<typeof drizzle>;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleDatabase['transaction']>[0]
>[0];

export function createPgPool(config: PoolConfig = {}): Pool {
  const pool = new Pool({ ...config, max: Math.min(config.max ?? 8, 8) });
  pool.on('error', (error) => {
    const code =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown';
    logger.error(`Idle PostgreSQL client error (code=${code})`);
  });
  return pool;
}

export function createDrizzle(pool: Pool): DrizzleDatabase {
  return drizzle(pool);
}

export async function withTx<T>(
  db: DrizzleDatabase,
  callback: (transaction: DrizzleTransaction) => Promise<T>,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 10;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(callback);
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt + 1 >= attempts)
        throw error;
      await delay(retryDelayMs * 2 ** attempt);
    }
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '40001' || candidate.code === '40P01') return true;
    current = candidate.cause;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
