import { apiRequest } from './api';
import type { CheckoutBooking } from './checkout';

export const BOOKINGS_PAGE_SIZE = 20;

export type CustomerBooking = Omit<CheckoutBooking, 'items'>;

export interface CustomerTicket {
  id: string;
  bookingId: string;
  eventId: string;
  seatId: string;
  status: 'VALID' | 'USED' | 'VOID';
  eventTitle: string;
  startsAt: string;
  usedAt: string | null;
  qrToken: string;
}

export function listCustomerBookings(page: number): Promise<CustomerBooking[]> {
  return apiRequest<CustomerBooking[]>(
    `/api/bookings?limit=${BOOKINGS_PAGE_SIZE}&offset=${page * BOOKINGS_PAGE_SIZE}`,
  );
}

export function cancelCustomerBooking(id: string): Promise<CustomerBooking> {
  return apiRequest<CustomerBooking>(
    `/api/bookings/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
    },
  );
}

export function listCustomerTickets(): Promise<CustomerTicket[]> {
  return apiRequest<CustomerTicket[]>('/api/tickets');
}

export function canRequestCancellation(
  status: CustomerBooking['status'],
): boolean {
  return status === 'AWAITING_PAYMENT' || status === 'CONFIRMED';
}
