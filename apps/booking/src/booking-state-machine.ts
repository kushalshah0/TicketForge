import { DomainError } from '@tf/common';
import { bookingStatus } from './database/schema';

type BookingStatus = (typeof bookingStatus.enumValues)[number];

const transitions: Record<BookingStatus, readonly BookingStatus[]> = {
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['CANCELLED'],
  CANCELLED: [],
  EXPIRED: [],
};

export class BookingStateMachine {
  static transition(from: BookingStatus, to: BookingStatus): BookingStatus {
    if (!transitions[from].includes(to)) {
      throw new DomainError(
        `Invalid booking transition: ${from} -> ${to}`,
        'INVALID_TRANSITION',
        409,
      );
    }
    return to;
  }
}
