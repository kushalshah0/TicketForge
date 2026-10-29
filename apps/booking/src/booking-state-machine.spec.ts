import { DomainError } from '@tf/common';
import { BookingStateMachine } from './booking-state-machine';
import { bookingStatus } from './database/schema';

const legalTransitions = new Set([
  'AWAITING_PAYMENT:CONFIRMED',
  'AWAITING_PAYMENT:CANCELLED',
  'AWAITING_PAYMENT:EXPIRED',
  'CONFIRMED:CANCELLED',
]);

describe('BookingStateMachine', () => {
  it('allows only the defined state transitions', () => {
    for (const from of bookingStatus.enumValues) {
      for (const to of bookingStatus.enumValues) {
        if (legalTransitions.has(`${from}:${to}`)) {
          expect(BookingStateMachine.transition(from, to)).toBe(to);
        } else {
          expect(() => BookingStateMachine.transition(from, to)).toThrow(
            DomainError,
          );
        }
      }
    }
  });

  it('reports invalid transitions with the domain error code', () => {
    try {
      BookingStateMachine.transition('CANCELLED', 'CONFIRMED');
      throw new Error('Expected an invalid transition to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });
    }
  });
});
