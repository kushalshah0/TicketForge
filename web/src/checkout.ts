import { ApiError, apiRequest } from './api';
import { getEventAvailability } from './events';

export interface CheckoutBooking {
  id: string;
  eventId: string;
  status: 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  totalMinor: number;
  currency: string;
  expiresAt: string;
  items: { seatId: string; priceMinor: number }[];
}

export interface CheckoutPayment {
  id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  scenario: string | null;
}

export type PaymentScenario = 'success' | 'fail' | 'slow' | 'duplicate';

export async function getCheckoutBooking(id: string) {
  const booking = await apiRequest<CheckoutBooking>(
    `/api/bookings/${encodeURIComponent(id)}`,
  );
  // Booking reads omit serverTime; availability provides the event's server clock.
  const availability =
    booking.status === 'AWAITING_PAYMENT'
      ? await getEventAvailability(booking.eventId)
      : undefined;
  if (availability)
    holdSecondsRemaining(booking.expiresAt, availability.serverTime, 0);
  return {
    booking,
    serverTime: availability?.serverTime,
    receivedAt: performance.now(),
  };
}

export async function getCheckoutPayment(
  id: string,
): Promise<CheckoutPayment | null> {
  try {
    return await apiRequest<CheckoutPayment>(
      `/api/payments/by-booking/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === 'PAYMENT_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
}

export function payForBooking(
  paymentId: string,
  idempotencyKey: string,
  scenario?: PaymentScenario,
) {
  return apiRequest<{ paymentId: string; status: string }>(
    `/api/payments/${encodeURIComponent(paymentId)}/pay`,
    {
      method: 'POST',
      idempotencyKey,
      body: scenario ? { scenario } : {},
    },
  );
}

export function holdSecondsRemaining(
  expiresAt: string,
  serverTime: string,
  elapsedMs: number,
): number {
  const expiry = Date.parse(expiresAt);
  const server = Date.parse(serverTime);
  if (
    !Number.isFinite(expiry) ||
    !Number.isFinite(server) ||
    !Number.isFinite(elapsedMs)
  ) {
    throw new Error('The server returned an invalid hold timestamp');
  }
  return Math.max(
    0,
    Math.ceil((expiry - server - Math.max(0, elapsedMs)) / 1_000),
  );
}
