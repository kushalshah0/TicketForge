import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, count, eq, isNull, min, sql } from 'drizzle-orm';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { MetricsService, type DrizzleDatabase } from '@tf/common';
import { MessagingService } from '@tf/messaging';
import { outbox } from './schema';

export const OUTBOX_DATABASE = Symbol('OUTBOX_DATABASE');

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  readonly registry: Registry;
  readonly unpublished: Gauge<string>;
  readonly lag: Histogram<string>;
  readonly oldestUnpublishedAge: Gauge<string>;
  readonly publishFailures: Counter<string>;

  private readonly intervalMs = positiveInteger(
    process.env.OUTBOX_POLL_INTERVAL_MS,
    500,
  );
  private readonly batchSize = positiveInteger(
    process.env.OUTBOX_BATCH_SIZE,
    50,
  );
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<number>;
  private stopped = false;

  constructor(
    @Inject(OUTBOX_DATABASE) private readonly database: DrizzleDatabase,
    private readonly messaging: MessagingService,
    @Optional() metrics?: MetricsService,
  ) {
    this.registry = metrics?.registry ?? new Registry();
    this.unpublished = new Gauge({
      name: 'outbox_unpublished',
      help: 'Number of unpublished outbox messages',
      registers: [this.registry],
    });
    this.lag = new Histogram({
      name: 'outbox_lag_seconds',
      help: 'Time between outbox creation and publish',
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });
    const databaseForMetrics = this.database;
    this.oldestUnpublishedAge = new Gauge({
      name: 'outbox_oldest_unpublished_age_seconds',
      help: 'Database-time age of the oldest unpublished outbox message, including stalled publishing',
      registers: [this.registry],
      async collect() {
        const [result] = await databaseForMetrics
          .select({
            age: sql<number>`greatest(0, coalesce(extract(epoch from (now() - ${min(outbox.createdAt)})), 0))::float8`,
          })
          .from(outbox)
          .where(isNull(outbox.publishedAt));
        if (!result || !Number.isFinite(result.age)) {
          throw new Error('Invalid oldest unpublished outbox age');
        }
        this.set(result.age);
      },
    });
    this.publishFailures = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Outbox batch publish failures',
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.relayOnce().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
    void this.relayOnce().catch(() => undefined);
  }

  async relayOnce(): Promise<number> {
    if (this.stopped) return 0;
    if (this.activeRun) return this.activeRun;

    const run = this.publishBatch();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  private async publishBatch(): Promise<number> {
    try {
      const publishedCount = await this.database.transaction(
        async (transaction) => {
          const rows = await transaction
            .select()
            .from(outbox)
            .where(isNull(outbox.publishedAt))
            .orderBy(asc(outbox.id))
            .limit(this.batchSize)
            .for('update', { skipLocked: true });

          for (const row of rows) {
            await this.messaging.publish(row.payload, row.headers.traceparent);
            await transaction
              .update(outbox)
              .set({ publishedAt: sql<Date>`now()` })
              .where(eq(outbox.id, row.id));
            this.lag.observe((Date.now() - row.createdAt.getTime()) / 1_000);
          }

          return rows.length;
        },
      );

      const [result] = await this.database
        .select({ value: count() })
        .from(outbox)
        .where(isNull(outbox.publishedAt));
      this.unpublished.set(result?.value ?? 0);
      return publishedCount;
    } catch (error) {
      this.publishFailures.inc();
      throw error;
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
