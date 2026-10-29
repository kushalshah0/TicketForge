import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { setAccessToken } from './api';
import {
  EVENTS_PAGE_SIZE,
  createBookingHold,
  formatMinorCurrency,
  keepAvailableSelections,
  listEvents,
  priceForSeat,
  readEventFilters,
  serializeEventFilters,
  toggleSeatSelection,
  type CatalogEvent,
  type EventAvailability,
} from './events';

afterEach(() => {
  setAccessToken(undefined);
  jest.restoreAllMocks();
});

describe('public event search', () => {
  it('round-trips search, city, and page through URL parameters', () => {
    const serialized = serializeEventFilters({
      q: '  jazz night ',
      city: ' Oslo ',
      page: 2,
    });
    expect(serialized).toBe('q=jazz+night&city=Oslo&page=2');
    expect(readEventFilters(serialized)).toEqual({
      q: 'jazz night',
      city: 'Oslo',
      page: 2,
    });
  });

  it('defaults invalid page values to the first page', () => {
    expect(readEventFilters('q=music&page=-1').page).toBe(0);
    expect(readEventFilters('page=not-a-number').page).toBe(0);
  });

  it('requests the selected filters and offset from the catalog API', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ items: [], total: 0 }));
    const filters = { q: 'jazz', city: 'Oslo', page: 2 };

    await expect(listEvents(filters)).resolves.toEqual({ items: [], total: 0 });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/events?limit=${EVENTS_PAGE_SIZE}&offset=${EVENTS_PAGE_SIZE * 2}&q=jazz&city=Oslo`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('maps seat prices from the availability section ID and formats minor units', () => {
    const event: CatalogEvent = {
      id: 'event-1',
      title: 'Jazz',
      description: '',
      venueName: 'Hall',
      city: 'Oslo',
      startsAt: '2026-12-01T18:00:00.000Z',
      currency: 'JPY',
      tiers: [{ id: 'tier-1', name: 'Standard', priceMinor: 1200 }],
      layout: {
        sections: [
          {
            id: 'section-uuid',
            name: 'Main',
            tierId: 'tier-1',
            rows: 1,
            seatsPerRow: 1,
          },
        ],
      },
    };
    const availability: EventAvailability = {
      eventId: event.id,
      serverTime: '2026-10-26T00:00:00.000Z',
      sections: [
        {
          sectionId: 'section-uuid',
          seats: [{ seatId: 'section-uuid-A1', status: 'AVAILABLE' }],
        },
      ],
    };

    expect(priceForSeat(event, availability, 'section-uuid-A1')).toBe(1200);
    expect(formatMinorCurrency(1200, 'JPY')).toContain('1,200');
  });

  it('limits selected seats to six and allows deselection', () => {
    const sixSeats = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
    expect(toggleSeatSelection(sixSeats, 'A7')).toBeNull();
    expect(toggleSeatSelection(sixSeats, 'A3')).toEqual([
      'A1',
      'A2',
      'A4',
      'A5',
      'A6',
    ]);
    expect(toggleSeatSelection(['A1'], 'A2')).toEqual(['A1', 'A2']);
  });

  it('drops selected seats that became unavailable during polling', () => {
    const availability: EventAvailability = {
      eventId: 'event-1',
      serverTime: '2026-10-26T00:00:00.000Z',
      sections: [
        {
          sectionId: 'section-1',
          seats: [
            { seatId: 'A1', status: 'AVAILABLE' },
            { seatId: 'A2', status: 'HELD' },
          ],
        },
      ],
    };
    expect(keepAvailableSelections(['A1', 'A2'], availability)).toEqual(['A1']);
  });

  it('sends holds with the supplied idempotency key', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ bookingId: 'booking-1' }));
    const seatIds = ['section-A1'];

    await expect(
      createBookingHold('event-1', seatIds, 'hold-key'),
    ).resolves.toEqual({
      bookingId: 'booking-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bookings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ eventId: 'event-1', seatIds }),
      }),
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe('hold-key');
  });
});
