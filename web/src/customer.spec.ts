import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  cancelCustomerBooking,
  canRequestCancellation,
  listCustomerBookings,
  listCustomerTickets,
} from './customer';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('customer booking and ticket API', () => {
  it('uses the backend page offset and owner-scoped ticket endpoint', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(Response.json([])));
    await expect(listCustomerBookings(2)).resolves.toEqual([]);
    await expect(listCustomerTickets()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/bookings?limit=20&offset=40',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tickets');
  });

  it('posts cancellation to the booking route and propagates closed-window errors', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          detail: 'Cancellation window closed',
          code: 'CANCELLATION_WINDOW_CLOSED',
        },
        {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        },
      ),
    );
    await expect(cancelCustomerBooking('booking/1')).rejects.toMatchObject({
      status: 409,
      code: 'CANCELLATION_WINDOW_CLOSED',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bookings/booking%2F1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('offers cancellation only for pending or confirmed bookings', () => {
    expect(canRequestCancellation('AWAITING_PAYMENT')).toBe(true);
    expect(canRequestCancellation('CONFIRMED')).toBe(true);
    expect(canRequestCancellation('EXPIRED')).toBe(false);
    expect(canRequestCancellation('CANCELLED')).toBe(false);
  });
});
