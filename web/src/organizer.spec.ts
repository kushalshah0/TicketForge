import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ApiError } from './api';
import {
  changeEventStatus,
  checkInErrorMessage,
  checkInTicket,
  createOrganizerEvent,
} from './organizer';

afterEach(() => {
  jest.restoreAllMocks();
});

function eventInput(rows = 1, seatsPerRow = 10) {
  const tierId = '00000000-0000-4000-8000-000000000001';
  return {
    title: 'Jazz',
    venueName: 'Hall',
    city: 'Oslo',
    startsAt: '2027-01-01T18:00:00Z',
    tiers: [{ id: tierId, name: 'Standard', priceMinor: 1200 }],
    layout: {
      sections: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'Main',
          tierId,
          rows,
          seatsPerRow,
        },
      ],
    },
  };
}

describe('organizer event and check-in API', () => {
  it('reuses catalog layout validation and rejects over 500 seats before making a request', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(createOrganizerEvent(eventInput(26, 40))).rejects.toThrow(
      '500 seats',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates validated drafts and uses publish/cancel endpoints', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ id: 'event-1' })),
      );
    await createOrganizerEvent(eventInput());
    await changeEventStatus('event-1', 'publish');
    await changeEventStatus('event-1', 'cancel');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/events',
      '/api/events/event-1/publish',
      '/api/events/event-1/cancel',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"currency":"NPR"');
  });

  it('posts trimmed tokens and distinguishes duplicate, void, invalid and wrong-organizer results', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ status: 'USED' }));
    await checkInTicket(' test-ticket-signature ');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      '{"token":"test-ticket-signature"}',
    );
    expect(
      checkInErrorMessage(new ApiError(409, 'Used', 'TICKET_ALREADY_USED')),
    ).toContain('Already used');
    expect(
      checkInErrorMessage(new ApiError(410, 'Void', 'TICKET_VOID')),
    ).toContain('Void ticket');
    expect(
      checkInErrorMessage(new ApiError(422, 'Invalid', 'TICKET_INVALID')),
    ).toContain('Invalid ticket');
    expect(
      checkInErrorMessage(new ApiError(403, 'Forbidden', 'EVENT_FORBIDDEN')),
    ).toContain('another organizer');
  });
});
