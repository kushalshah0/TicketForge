import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type PaymentScenario = 'success' | 'fail' | 'slow' | 'duplicate';

export interface PaymentCharge {
  paymentId: string;
  bookingId: string;
  scenario: PaymentScenario;
}

export type MockWebhookPayload = {
  providerEventId: string;
  paymentId: string;
  bookingId: string;
  providerRef: string;
} & ({ outcome: 'succeeded' } | { outcome: 'failed'; reason: string });

export const mockWebhookSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      providerEventId: z.string().uuid(),
      paymentId: z.string().uuid(),
      bookingId: z.string().uuid(),
      outcome: z.literal('succeeded'),
      providerRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      providerEventId: z.string().uuid(),
      paymentId: z.string().uuid(),
      bookingId: z.string().uuid(),
      outcome: z.literal('failed'),
      providerRef: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

export interface PaymentProvider {
  createCharge(charge: PaymentCharge): Promise<void>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export class MockProvider implements PaymentProvider {
  constructor(
    private readonly secret: string,
    private readonly webhookUrl: string,
  ) {
    if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET is required');
  }

  async createCharge({
    paymentId,
    bookingId,
    scenario,
  }: PaymentCharge): Promise<void> {
    if (scenario === 'slow') await delay(20_000);

    const payloadBase = {
      providerEventId: randomUUID(),
      paymentId,
      bookingId,
      providerRef: `mock:${paymentId}`,
    };
    const payload: MockWebhookPayload =
      scenario === 'fail'
        ? { ...payloadBase, outcome: 'failed', reason: 'Mock payment failed' }
        : { ...payloadBase, outcome: 'succeeded' };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = this.sign(body);
    const deliveries = scenario === 'duplicate' ? 2 : 1;

    for (let delivery = 0; delivery < deliveries; delivery += 1) {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': signature,
        },
        body,
      });
      if (!response.ok) {
        throw new Error(
          `Mock webhook delivery failed with status ${response.status}`,
        );
      }
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    const match = /^sha256=([a-f0-9]{64})$/.exec(signature ?? '');
    if (!match?.[1]) return false;
    const provided = Buffer.from(match[1], 'hex');
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  private sign(rawBody: Buffer): string {
    return `sha256=${createHmac('sha256', this.secret).update(rawBody).digest('hex')}`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPaymentProvider(): PaymentProvider {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET is required');
  const port = process.env.PORT ?? '3004';
  return new MockProvider(
    secret,
    `http://127.0.0.1:${port}/internal/webhooks/mock`,
  );
}
