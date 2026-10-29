import { jest } from '@jest/globals';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

describe('BookingController', () => {
  it('passes the event ID to the availability service', async () => {
    const getAvailability = jest
      .fn<(eventId: string) => Promise<{ eventId: string }>>()
      .mockResolvedValue({
        eventId: 'event-1',
      });
    const service = { getAvailability } as unknown as BookingService;
    const bookingController = new BookingController(service);

    await expect(bookingController.getAvailability('event-1')).resolves.toEqual(
      { eventId: 'event-1' },
    );

    expect(getAvailability).toHaveBeenCalledWith('event-1');
  });
});
