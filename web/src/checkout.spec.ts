import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  getCheckoutBooking,
  getCheckoutPayment,
  holdSecondsRemaining,
  payForBooking,
} from './checkout';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('checkout', () => {
  it('uses server time and elapsed duration rather than the local wall clock', () => {
    expect(
      holdSecondsRemaining(
        '2026-10-26T10:10:00Z',
        '2026-10-26T10:00:00Z',
        30_000,
      ),
    ).toBe(570);
    expect(
      holdSecondsRemaining(
        '2026-10-26T10:10:00Z',
        '2026-10-26T10:00:00Z',
        600_000,
      ),
    ).toBe(0);
    expect(
      holdSecondsRemaining(
        '2026-10-26T10:10:00Z',
        '2026-10-26T10:00:00Z',
        700_000,
      ),
    ).toBe(0);
    expect(() => holdSecondsRemaining('invalid', 'invalid', 0)).toThrow(
      'invalid hold timestamp',
    );
  });

  it('loads the clock from availability for existing booking APIs', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          id: 'booking-1',
          eventId: 'event-1',
          status: 'AWAITING_PAYMENT',
          expiresAt: '2026-10-26T10:10:00Z',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ serverTime: '2026-10-26T10:00:00Z' }),
      );
    await expect(getCheckoutBooking('booking-1')).resolves.toMatchObject({
      booking: { id: 'booking-1' },
      serverTime: '2026-10-26T10:00:00Z',
    });
  });

  it('waits only for a missing payment, not infrastructure errors', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: 'PAYMENT_NOT_FOUND' },
        {
          status: 404,
          headers: { 'Content-Type': 'application/problem+json' },
        },
      ),
    );
    await expect(getCheckoutPayment('booking-1')).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: 'Unavailable' },
        {
          status: 503,
          headers: { 'Content-Type': 'application/problem+json' },
        },
      ),
    );
    await expect(getCheckoutPayment('booking-1')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('preserves the payment idempotency key and omits demo scenarios outside demo mode', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ status: 'PENDING' })),
      );
    await payForBooking('payment-1', 'attempt-key');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{}');
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe('attempt-key');
    await payForBooking('payment-1', 'demo-key', 'slow');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"scenario":"slow"}');
  });
});
