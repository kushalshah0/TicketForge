import type { Pool } from 'pg';

export interface BookingInvariantViolations {
  heldSeatsWithoutBooking: number;
  heldSeatsForInactiveBooking: number;
  duplicateActiveBookingSeats: number;
}

export async function readBookingInvariantViolations(
  pool: Pool,
): Promise<BookingInvariantViolations> {
  const result = await pool.query<BookingInvariantViolations>(`
    SELECT
      (SELECT count(*)::int
       FROM seats
       WHERE status IN ('HELD', 'SOLD') AND booking_id IS NULL) AS "heldSeatsWithoutBooking",
      (SELECT count(*)::int
       FROM seats s
       JOIN bookings b ON b.id = s.booking_id
       WHERE s.status = 'HELD' AND b.status <> 'AWAITING_PAYMENT') AS "heldSeatsForInactiveBooking",
      (SELECT count(*)::int
       FROM (
         SELECT bi.event_id, bi.seat_id
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE b.status IN ('AWAITING_PAYMENT', 'CONFIRMED')
         GROUP BY bi.event_id, bi.seat_id
         HAVING count(*) > 1
       ) duplicate_seats) AS "duplicateActiveBookingSeats"
  `);
  const violations = result.rows[0];
  if (!violations)
    throw new Error('Booking invariant query returned no results');
  return violations;
}
