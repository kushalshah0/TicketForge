import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  createDrizzle,
  createPgPool,
  DomainError,
  getCorrelationId,
  MetricsService,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '@tf/common';
import { makeEnvelope } from '@tf/contracts';
import { OutboxService } from '@tf/outbox';
import {
  catalogLayoutAndTiersSchema,
  catalogSearchSchema,
  createCatalogEventSchema,
  updateCatalogEventSchema,
} from './catalog.schemas';
import { events } from './database/schema';

export const CATALOG_POOL = Symbol('CATALOG_POOL');
export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

@Injectable()
export class CatalogService implements OnModuleDestroy {
  private readonly redis = new Redis(
    process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    },
  );

  constructor(
    @Inject(CATALOG_DATABASE) private readonly database: DrizzleDatabase,
    @Inject(CATALOG_POOL) private readonly pool: Pool,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') await this.redis.quit();
    else this.redis.disconnect();
    await this.pool.end();
  }

  async listPublished(input: unknown) {
    const query = parseInput(catalogSearchSchema, input);
    const version = await this.getCacheVersion();
    const cacheKey = `catalog:v${version}:list:${JSON.stringify(query)}`;
    const cached = await this.getCached<{ items: unknown[]; total: number }>(
      cacheKey,
    );
    if (cached) return cached;

    const filters = [eq(events.status, 'PUBLISHED' as const)];
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      const textFilter = or(
        ilike(events.title, pattern),
        ilike(events.city, pattern),
      );
      if (textFilter) filters.push(textFilter);
    }
    if (query.city)
      filters.push(
        ilike(events.city, `%${query.city.replace(/[\\%_]/g, '\\$&')}%`),
      );
    if (query.from) filters.push(gte(events.startsAt, query.from));
    if (query.to) filters.push(lte(events.startsAt, query.to));
    const where = and(...filters);
    const [items, [totalRow]] = await Promise.all([
      this.database
        .select()
        .from(events)
        .where(where)
        .orderBy(events.startsAt)
        .limit(query.limit)
        .offset(query.offset),
      this.database.select({ total: count() }).from(events).where(where),
    ]);
    const result = { items, total: totalRow?.total ?? 0 };
    await this.setCached(cacheKey, result, 15);
    return result;
  }

  async getPublished(eventId: string) {
    const id = parseUuid(eventId);
    const version = await this.getCacheVersion();
    const cacheKey = `catalog:v${version}:event:${id}`;
    const cached = await this.getCached(cacheKey);
    if (cached) return cached;
    const [event] = await this.database
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.status, 'PUBLISHED')))
      .limit(1);
    if (!event)
      throw new DomainError('Event not found', 'EVENT_NOT_FOUND', 404);
    await this.setCached(cacheKey, event, 60);
    return event;
  }

  async createDraft(organizerId: string, input: unknown) {
    const parsed = parseInput(createCatalogEventSchema, input);
    const [event] = await this.database
      .insert(events)
      .values({ ...parsed, organizerId: parseUuid(organizerId) })
      .returning();
    if (!event) throw new Error('Catalog event insert returned no row');
    return event;
  }

  async updateEvent(organizerId: string, eventId: string, input: unknown) {
    const id = parseUuid(eventId);
    const parsed = parseInput(updateCatalogEventSchema, input);
    const updated = await this.database.transaction(async (transaction) => {
      const event = await this.getOwnedEvent(transaction, organizerId, id);
      if (event.status === 'CANCELLED') {
        throw new DomainError(
          'Cancelled events cannot be edited',
          'EVENT_CANCELLED',
          409,
        );
      }
      if (
        event.status === 'PUBLISHED' &&
        ('layout' in parsed ||
          'tiers' in parsed ||
          'venueName' in parsed ||
          'city' in parsed ||
          'currency' in parsed)
      ) {
        throw new DomainError(
          'Published event layout and venue are immutable',
          'EVENT_IMMUTABLE',
          409,
        );
      }
      const [updated] = await transaction
        .update(events)
        .set({
          ...parsed,
          updatedAt: new Date(),
          versionNo: event.versionNo + 1,
        })
        .where(eq(events.id, id))
        .returning();
      if (!updated) throw new Error('Catalog event update returned no row');
      if (
        event.status === 'PUBLISHED' &&
        ('title' in parsed || 'startsAt' in parsed)
      ) {
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'event.updated',
            {
              eventId: updated.id,
              title: updated.title,
              startsAt: updated.startsAt.toISOString(),
            },
            { correlationId: getCorrelationId() ?? randomUUID() },
          ),
        );
      }
      return updated;
    });
    await this.invalidatePublicCache();
    return updated;
  }

  async publishEvent(organizerId: string, eventId: string) {
    const id = parseUuid(eventId);
    const published = await this.database.transaction(async (transaction) => {
      const event = await this.getOwnedEvent(transaction, organizerId, id);
      if (event.status !== 'DRAFT') {
        throw new DomainError(
          'Only draft events can be published',
          'EVENT_NOT_DRAFT',
          409,
        );
      }
      if (event.startsAt.getTime() <= Date.now() + 60 * 60 * 1_000) {
        throw new DomainError(
          'Event must start more than one hour from now',
          'EVENT_START_TOO_SOON',
          422,
        );
      }
      if (event.tiers.length === 0) {
        throw new DomainError(
          'At least one tier is required to publish',
          'EVENT_INVALID',
          422,
        );
      }
      const validated = catalogLayoutAndTiersSchema.safeParse({
        layout: event.layout,
        tiers: event.tiers,
      });
      if (!validated.success) {
        throw new DomainError(
          validated.error.issues[0]?.message ?? 'Invalid event layout',
          'EVENT_INVALID',
          422,
        );
      }
      const [published] = await transaction
        .update(events)
        .set({
          status: 'PUBLISHED',
          publishedAt: new Date(),
          updatedAt: new Date(),
          versionNo: event.versionNo + 1,
        })
        .where(eq(events.id, id))
        .returning();
      if (!published) throw new Error('Catalog event publish returned no row');
      await this.outbox.write(
        transaction,
        makeEnvelope(
          'event.published',
          {
            eventId: published.id,
            organizerId: published.organizerId,
            title: published.title,
            startsAt: published.startsAt.toISOString(),
            venueName: published.venueName,
            city: published.city,
            currency: published.currency,
            tiers: validated.data.tiers,
            layout: validated.data.layout,
          },
          { correlationId: getCorrelationId() ?? randomUUID() },
        ),
      );
      return published;
    });
    await this.invalidatePublicCache();
    return published;
  }

  async cancelEvent(organizerId: string, eventId: string) {
    const id = parseUuid(eventId);
    const cancelled = await this.database.transaction(async (transaction) => {
      const event = await this.getOwnedEvent(transaction, organizerId, id);
      if (event.status === 'CANCELLED') {
        throw new DomainError(
          'Event is already cancelled',
          'EVENT_CANCELLED',
          409,
        );
      }
      const [cancelled] = await transaction
        .update(events)
        .set({
          status: 'CANCELLED',
          cancelledAt: new Date(),
          updatedAt: new Date(),
          versionNo: event.versionNo + 1,
        })
        .where(eq(events.id, id))
        .returning();
      if (!cancelled)
        throw new Error('Catalog event cancellation returned no row');
      if (event.status === 'PUBLISHED') {
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'event.cancelled',
            { eventId: cancelled.id, reason: 'ORGANIZER_CANCELLED' },
            { correlationId: getCorrelationId() ?? randomUUID() },
          ),
        );
      }
      return cancelled;
    });
    await this.invalidatePublicCache();
    return cancelled;
  }

  async listOrganizerEvents(organizerId: string) {
    return this.database
      .select()
      .from(events)
      .where(eq(events.organizerId, parseUuid(organizerId)))
      .orderBy(desc(events.createdAt));
  }

  private async getOwnedEvent(
    transaction: DrizzleTransaction,
    organizerId: string,
    eventId: string,
  ) {
    const [event] = await transaction
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for('update');
    if (!event)
      throw new DomainError('Event not found', 'EVENT_NOT_FOUND', 404);
    if (event.organizerId !== organizerId) {
      throw new DomainError('You do not own this event', 'FORBIDDEN', 403);
    }
    return event;
  }

  private async getCacheVersion(): Promise<string> {
    try {
      return (await this.redis.get('events:version')) ?? '0';
    } catch {
      return 'uncached';
    }
  }

  private async getCached<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.redis.get(key);
      if (!value) {
        this.metrics?.cacheRequests.inc({ result: 'miss' });
        return undefined;
      }
      const cached = JSON.parse(value) as T;
      this.metrics?.cacheRequests.inc({ result: 'hit' });
      return cached;
    } catch {
      this.metrics?.cacheRequests.inc({ result: 'error' });
      return undefined;
    }
  }

  private async setCached(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {}
  }

  private async invalidatePublicCache(): Promise<void> {
    try {
      await this.redis.incr('events:version');
    } catch {}
  }
}

export function createCatalogPool(): Pool {
  const connectionString =
    process.env.CATALOG_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('CATALOG_DATABASE_URL is required');
  return createPgPool({ connectionString });
}

export function createCatalogDatabase(pool: Pool): DrizzleDatabase {
  return createDrizzle(pool);
}

function parseInput<TOutput, TInput>(
  schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>,
  input: unknown,
): TOutput {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError(
      parsed.error.issues[0]?.message ?? 'Invalid catalog event',
      'VALIDATION_FAILED',
      422,
    );
  }
  return parsed.data;
}

function parseUuid(value: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new DomainError('Invalid event ID', 'VALIDATION_FAILED', 422);
  }
  return value;
}
