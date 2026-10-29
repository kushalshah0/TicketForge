import { createHmac } from 'node:crypto';
import { jest } from '@jest/globals';
import { MockProvider, type MockWebhookPayload } from './payment-provider';

const webhookUrl = 'http://127.0.0.1:3004/internal/webhooks/mock';

describe('MockProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('verifies signatures against the exact raw request body', () => {
    const provider = new MockProvider('test-secret', webhookUrl);
    const body = Buffer.from('{"outcome":"succeeded"}');
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;

    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(
      provider.verifyWebhook(Buffer.from('{"outcome":"failed"}'), signature),
    ).toBe(false);
    expect(provider.verifyWebhook(body, undefined)).toBe(false);
    expect(provider.verifyWebhook(body, 'invalid')).toBe(false);
  });

  it('delivers success, failure, and duplicate scenarios with signed bodies', async () => {
    const provider = new MockProvider('test-secret', webhookUrl);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));

    await provider.createCharge({
      paymentId: 'payment-1',
      bookingId: 'booking-1',
      scenario: 'success',
    });
    await provider.createCharge({
      paymentId: 'payment-2',
      bookingId: 'booking-2',
      scenario: 'fail',
    });
    await provider.createCharge({
      paymentId: 'payment-3',
      bookingId: 'booking-3',
      scenario: 'duplicate',
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const payloads = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(rawBody(init).toString('utf8')) as MockWebhookPayload,
    );
    expect(payloads.map(({ outcome }) => outcome)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
      'succeeded',
    ]);
    expect(payloads[2]?.providerEventId).toBe(payloads[3]?.providerEventId);
    for (const [input, init] of fetchMock.mock.calls) {
      const body = rawBody(init);
      expect(input).toBe(webhookUrl);
      expect(
        provider.verifyWebhook(
          body,
          new Headers(init?.headers).get('x-mock-signature') ?? undefined,
        ),
      ).toBe(true);
    }
  });

  it('waits 20 seconds before delivering the slow scenario', async () => {
    jest.useFakeTimers();
    const provider = new MockProvider('test-secret', webhookUrl);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    const charge = provider.createCharge({
      paymentId: 'payment-slow',
      bookingId: 'booking-slow',
      scenario: 'slow',
    });

    await jest.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await charge;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function rawBody(init: RequestInit | undefined): Buffer {
  if (!(init?.body instanceof Uint8Array))
    throw new Error('Mock provider did not send a byte body');
  return Buffer.from(init.body);
}
