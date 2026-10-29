import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  createDrizzle,
  createPgPool,
  DomainError,
  type DrizzleDatabase,
} from '@tf/common';
import { makeEnvelope } from '@tf/contracts';
import { OutboxService } from '@tf/outbox';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  idempotencyKeys,
  payments,
  webhookDeliveries,
} from './database/schema';
import {
  PAYMENT_PROVIDER,
  mockWebhookSchema,
  type PaymentProvider,
  type PaymentScenario,
} from './payment-provider';

export const PAYMENT_POOL = Symbol('PAYMENT_POOL');
export const PAYMENT_DATABASE = Symbol('PAYMENT_DATABASE');

const paymentScenarioSchema = z
  .object({
    scenario: z.enum(['success', 'fail', 'slow', 'duplicate']),
  })
  .strict();

export interface PaymentInitiation {
  paymentId: string;
  status: string;
}

type PaymentAttempt =
  | { response: PaymentInitiation; shouldCharge: false }
  | {
      response: PaymentInitiation;
      shouldCharge: true;
      bookingId: string;
      scenario: PaymentScenario;
    };

@Injectable()
export class PaymentService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject(PAYMENT_POOL) private readonly pool: Pool,
    @Inject(PAYMENT_DATABASE) private readonly database: DrizzleDatabase,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly outbox: OutboxService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async getPaymentByBooking(userId: string, bookingId: string) {
    const ownerId = parseUuid(userId);
    const id = parseUuid(bookingId);
    const [payment] = await this.database
      .select()
      .from(payments)
      .where(and(eq(payments.bookingId, id), eq(payments.userId, ownerId)))
      .limit(1);
    if (!payment)
      throw new DomainError('Payment not found', 'PAYMENT_NOT_FOUND', 404);
    return payment;
  }

  async pay(
    userId: string,
    paymentId: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ): Promise<PaymentInitiation> {
    const ownerId = parseUuid(userId);
    const id = parseUuid(paymentId);
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new DomainError(
        'Idempotency-Key header is required',
        'IDEMPOTENCY_KEY_REQUIRED',
        400,
      );
    }
    if (process.env.DEMO_MODE !== 'true') {
      if (hasScenario(input)) {
        throw new DomainError(
          'Demo payment scenarios are disabled',
          'DEMO_MODE_DISABLED',
          403,
        );
      }
      throw new DomainError(
        'A live payment provider is not configured',
        'PAYMENT_PROVIDER_UNAVAILABLE',
        503,
      );
    }
    const parsed = paymentScenarioSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        parsed.error.issues[0]?.message ?? 'Invalid payment request',
        'VALIDATION_FAILED',
        422,
      );
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ paymentId: id, scenario: parsed.data.scenario }))
      .digest('hex');

    const result: PaymentAttempt = await this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:${idempotencyKey}`}, 0))`,
        );
        const [existing] = await transaction
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.userId, ownerId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new DomainError(
              'Idempotency key was already used for another request',
              'IDEMPOTENCY_KEY_REUSED',
              422,
            );
          }
          return {
            response: existing.responseBody,
            shouldCharge: false as const,
          };
        }

        const [payment] = await transaction
          .select()
          .from(payments)
          .where(and(eq(payments.id, id), eq(payments.userId, ownerId)))
          .for('update')
          .limit(1);
        if (!payment)
          throw new DomainError('Payment not found', 'PAYMENT_NOT_FOUND', 404);
        if (payment.status !== 'PENDING') {
          throw new DomainError(
            'Payment is not pending',
            'PAYMENT_NOT_PENDING',
            409,
          );
        }
        const [expiry] = await transaction
          .select({ active: sql<boolean>`${payments.expiresAt} > now()` })
          .from(payments)
          .where(eq(payments.id, id))
          .limit(1);
        if (!expiry?.active) {
          throw new DomainError('Payment has expired', 'PAYMENT_EXPIRED', 409);
        }
        if (payment.scenario) {
          throw new DomainError(
            'Payment has already been initiated',
            'PAYMENT_ALREADY_INITIATED',
            409,
          );
        }

        const response: PaymentInitiation = {
          paymentId: payment.id,
          status: payment.status,
        };
        await transaction
          .update(payments)
          .set({ scenario: parsed.data.scenario, updatedAt: sql`now()` })
          .where(eq(payments.id, id));
        await transaction.insert(idempotencyKeys).values({
          userId: ownerId,
          key: idempotencyKey,
          requestHash,
          responseStatus: 202,
          responseBody: response,
        });
        return {
          response,
          shouldCharge: true as const,
          bookingId: payment.bookingId,
          scenario: parsed.data.scenario,
        };
      },
    );

    if (result.shouldCharge) {
      void this.provider
        .createCharge({
          paymentId: result.response.paymentId,
          bookingId: result.bookingId,
          scenario: result.scenario,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Payment provider charge failed for payment ${result.response.paymentId}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    }
    return result.response;
  }

  async handleWebhook(input: unknown): Promise<void> {
    const parsed = mockWebhookSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        parsed.error.issues[0]?.message ?? 'Invalid payment webhook',
        'INVALID_WEBHOOK',
        422,
      );
    }
    const webhook = parsed.data;

    await this.database.transaction(async (transaction) => {
      const [delivery] = await transaction
        .insert(webhookDeliveries)
        .values({ providerEventId: webhook.providerEventId, payload: webhook })
        .onConflictDoNothing({ target: webhookDeliveries.providerEventId })
        .returning({ providerEventId: webhookDeliveries.providerEventId });
      if (!delivery) return;

      const [payment] = await transaction
        .select()
        .from(payments)
        .where(eq(payments.id, webhook.paymentId))
        .for('update')
        .limit(1);
      if (!payment)
        throw new DomainError('Payment not found', 'PAYMENT_NOT_FOUND', 404);
      if (payment.status !== 'PENDING') {
        this.logger.warn(
          `Ignoring ${webhook.outcome} webhook ${webhook.providerEventId} for payment ${payment.id} in ${payment.status}`,
        );
        return;
      }

      if (webhook.outcome === 'succeeded') {
        await transaction
          .update(payments)
          .set({
            status: 'SUCCEEDED',
            providerRef: webhook.providerRef,
            updatedAt: sql`now()`,
          })
          .where(eq(payments.id, payment.id));
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'payment.succeeded',
            {
              paymentId: payment.id,
              bookingId: payment.bookingId,
              amountMinor: payment.amountMinor,
              providerRef: webhook.providerRef,
            },
            { correlationId: randomUUID() },
          ),
        );
      } else {
        await transaction
          .update(payments)
          .set({
            status: 'FAILED',
            providerRef: webhook.providerRef,
            updatedAt: sql`now()`,
          })
          .where(eq(payments.id, payment.id));
        await this.outbox.write(
          transaction,
          makeEnvelope(
            'payment.failed',
            {
              paymentId: payment.id,
              bookingId: payment.bookingId,
              reason: webhook.reason,
            },
            { correlationId: randomUUID() },
          ),
        );
      }
    });
  }

  getHello(): string {
    return 'Hello World!';
  }
}

function parseUuid(value: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new DomainError('Invalid ID', 'VALIDATION_FAILED', 422);
  }
  return value;
}

function hasScenario(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    Object.hasOwn(input, 'scenario')
  );
}

export function createPaymentPool(): Pool {
  const connectionString =
    process.env.PAYMENT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('PAYMENT_DATABASE_URL is required');
  return createPgPool({ connectionString });
}

export function createPaymentDatabase(pool: Pool): DrizzleDatabase {
  return createDrizzle(pool);
}
