import { apiRequest, createIdempotencyKey } from './api';

export const EVENTS_PAGE_SIZE = 20;

export interface EventFilters {
  q: string;
  city: string;
  page: number;
}

export interface CatalogEvent {
  id: string;
  title: string;
  description: string;
  venueName: string;
  city: string;
  startsAt: string;
  currency: string;
  tiers: { id: string; name: string; priceMinor: number }[];
  layout: {
    sections: {
      id: string;
      name: string;
      tierId: string;
      rows: number;
      seatsPerRow: number;
    }[];
  };
}

export interface EventAvailability {
  eventId: string;
  serverTime: string;
  sections: {
    sectionId: string;
    seats: {
      seatId: string;
      status: 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED';
    }[];
  }[];
}

export interface BookingHold {
  bookingId: string;
  eventId: string;
  seatIds: string[];
  status: 'AWAITING_PAYMENT';
  totalMinor: number;
  currency: string;
  expiresAt: string;
  serverTime: string;
}

export interface EventSearchResult {
  items: CatalogEvent[];
  total: number;
}

export function readEventFilters(search: string): EventFilters {
  const params = new URLSearchParams(search);
  const page = Number(params.get('page') ?? 0);
  return {
    q: params.get('q') ?? '',
    city: params.get('city') ?? '',
    page:
      Number.isSafeInteger(page) &&
      page >= 0 &&
      page <= Math.floor(Number.MAX_SAFE_INTEGER / EVENTS_PAGE_SIZE)
        ? page
        : 0,
  };
}

export function serializeEventFilters(filters: EventFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.city.trim()) params.set('city', filters.city.trim());
  if (filters.page > 0) params.set('page', String(filters.page));
  return params.toString();
}

export function listEvents(filters: EventFilters): Promise<EventSearchResult> {
  const params = new URLSearchParams({
    limit: String(EVENTS_PAGE_SIZE),
    offset: String(filters.page * EVENTS_PAGE_SIZE),
  });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.city.trim()) params.set('city', filters.city.trim());
  return apiRequest<EventSearchResult>(`/api/events?${params.toString()}`);
}

export function getEvent(id: string): Promise<CatalogEvent> {
  return apiRequest<CatalogEvent>(`/api/events/${encodeURIComponent(id)}`);
}

export function getEventAvailability(id: string): Promise<EventAvailability> {
  return apiRequest<EventAvailability>(
    `/api/events/${encodeURIComponent(id)}/availability`,
  );
}

export function createBookingHold(
  eventId: string,
  seatIds: string[],
  idempotencyKey = createIdempotencyKey(),
): Promise<BookingHold> {
  return apiRequest<BookingHold>('/api/bookings', {
    method: 'POST',
    body: { eventId, seatIds },
    idempotencyKey,
  });
}

export function toggleSeatSelection(
  seatIds: string[],
  seatId: string,
): string[] | null {
  if (seatIds.includes(seatId))
    return seatIds.filter((selected) => selected !== seatId);
  if (seatIds.length >= 6) return null;
  return [...seatIds, seatId];
}

export function keepAvailableSelections(
  seatIds: string[],
  availability: EventAvailability,
): string[] {
  const availableSeatIds = new Set(
    availability.sections.flatMap((section) =>
      section.seats
        .filter((seat) => seat.status === 'AVAILABLE')
        .map((seat) => seat.seatId),
    ),
  );
  return seatIds.filter((seatId) => availableSeatIds.has(seatId));
}

export function formatMinorCurrency(
  amountMinor: number,
  currency: string,
): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (fractionDigits === undefined)
    throw new Error(`Could not determine minor unit scale for ${currency}`);
  return formatter.format(amountMinor / 10 ** fractionDigits);
}

export function priceForSeat(
  event: CatalogEvent,
  availability: EventAvailability,
  seatId: string,
): number {
  const sectionId = availability.sections.find((section) =>
    section.seats.some((seat) => seat.seatId === seatId),
  )?.sectionId;
  const section = event.layout.sections.find((item) => item.id === sectionId);
  return (
    event.tiers.find((tier) => tier.id === section?.tierId)?.priceMinor ?? 0
  );
}
