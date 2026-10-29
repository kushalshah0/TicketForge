import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { useAuth } from './auth';
import {
  BOOKINGS_PAGE_SIZE,
  cancelCustomerBooking,
  canRequestCancellation,
  listCustomerBookings,
  listCustomerTickets,
  type CustomerBooking,
  type CustomerTicket,
} from './customer';
import { formatMinorCurrency } from './events';

export function BookingsPage() {
  const { session } = useAuth();
  const [page, setPage] = useState(0);
  const bookings = useQuery({
    queryKey: ['customer-bookings', session?.user.id, page],
    queryFn: () => listCustomerBookings(page),
    enabled: Boolean(session),
    refetchInterval: 5_000,
  });

  return (
    <section>
      <h1 className="text-3xl font-semibold">My bookings</h1>
      <p className="mt-3 text-sm text-slate-400">
        Unpaid holds can be cancelled. Confirmed bookings can be cancelled more
        than 24 hours before the event.
      </p>
      {bookings.isPending ? (
        <p className="mt-6" role="status">
          Loading bookings...
        </p>
      ) : bookings.isError ? (
        <div className="mt-6" role="alert">
          <p>{bookings.error.message}</p>
          <button
            className="mt-3 underline"
            onClick={() => void bookings.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {bookings.data.length === 0 ? (
            <p className="mt-6">
              No bookings on this page.{' '}
              <Link className="text-cyan-300 underline" to="/events">
                Browse events
              </Link>
            </p>
          ) : (
            <ul className="mt-6 space-y-4">
              {bookings.data.map((booking) => (
                <BookingCard booking={booking} key={booking.id} />
              ))}
            </ul>
          )}
          <div className="mt-6 flex items-center gap-4">
            <button
              className="secondary-button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              type="button"
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              className="secondary-button"
              disabled={bookings.data.length < BOOKINGS_PAGE_SIZE}
              onClick={() => setPage(page + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function BookingCard({ booking }: { booking: CustomerBooking }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancellation = useMutation({
    mutationFn: () => cancelCustomerBooking(booking.id),
    onSuccess: () => {
      setConfirmCancel(false);
      void queryClient.invalidateQueries({
        queryKey: ['customer-bookings', session?.user.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['customer-tickets', session?.user.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['checkout-booking', booking.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['event-availability', booking.eventId],
      });
    },
  });
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="break-all font-medium">Booking {booking.id}</h2>
      <p className="mt-2">
        {formatMinorCurrency(booking.totalMinor, booking.currency)}
      </p>
      <p className="mt-2 text-sm text-cyan-300">
        Status: {booking.status.replaceAll('_', ' ')}
      </p>
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link className="underline" to={`/checkout/${booking.id}`}>
          View booking
        </Link>
        <Link className="underline" to={`/events/${booking.eventId}`}>
          View event
        </Link>
        {booking.status === 'CONFIRMED' && (
          <Link className="underline" to="/tickets">
            View tickets
          </Link>
        )}
        {canRequestCancellation(booking.status) && !confirmCancel && (
          <button
            className="text-rose-300 underline"
            onClick={() => setConfirmCancel(true)}
            type="button"
          >
            Cancel booking
          </button>
        )}
      </div>
      {confirmCancel && canRequestCancellation(booking.status) && (
        <div className="mt-4 rounded border border-amber-800 p-4">
          <p>
            Cancel this booking? Its seats will be released and any issued
            tickets will become void.
          </p>
          <div className="mt-3 flex gap-4">
            <button
              disabled={cancellation.isPending}
              onClick={() => cancellation.mutate()}
              type="button"
            >
              {cancellation.isPending ? 'Cancelling...' : 'Yes, cancel booking'}
            </button>
            <button
              disabled={cancellation.isPending}
              onClick={() => setConfirmCancel(false)}
              type="button"
            >
              Keep booking
            </button>
          </div>
        </div>
      )}
      {cancellation.isError && (
        <p className="mt-3 text-rose-300" role="alert">
          {cancellation.error.message}
        </p>
      )}
      {cancellation.isSuccess && (
        <p className="mt-3 text-emerald-300" role="status">
          Booking cancelled. Any refund will be processed automatically.
        </p>
      )}
    </li>
  );
}

export function TicketsPage() {
  const { session } = useAuth();
  const tickets = useQuery({
    queryKey: ['customer-tickets', session?.user.id],
    queryFn: listCustomerTickets,
    enabled: Boolean(session),
    refetchInterval: 5_000,
  });
  return (
    <section>
      <h1 className="text-3xl font-semibold">My tickets</h1>
      {tickets.isPending ? (
        <p className="mt-6" role="status">
          Loading tickets...
        </p>
      ) : tickets.isError ? (
        <div className="mt-6" role="alert">
          <p>{tickets.error.message}</p>
          <button
            className="mt-3 underline"
            onClick={() => void tickets.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : tickets.data.length === 0 ? (
        <p className="mt-6">
          No tickets yet. Tickets appear after your booking is confirmed.
        </p>
      ) : (
        <ul className="mt-6 grid gap-5 sm:grid-cols-2">
          {tickets.data.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TicketCard({ ticket }: { ticket: CustomerTicket }) {
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-xl font-semibold">{ticket.eventTitle}</h2>
      <p className="mt-2">
        <time dateTime={ticket.startsAt}>
          {new Date(ticket.startsAt).toLocaleString()}
        </time>
      </p>
      <p className="mt-2 break-all text-sm">Seat: {ticket.seatId}</p>
      <p className="mt-2 font-medium">Status: {ticket.status}</p>
      {ticket.status === 'VALID' ? (
        <TicketQr key={ticket.qrToken} token={ticket.qrToken} />
      ) : (
        <p className="mt-4 text-amber-200">
          {ticket.status === 'VOID'
            ? 'This ticket is void and cannot be used for entry.'
            : 'This ticket has already been used.'}
        </p>
      )}
      {ticket.usedAt && (
        <p className="mt-3 text-sm">
          Checked in: {new Date(ticket.usedAt).toLocaleString()}
        </p>
      )}
      <Link
        className="mt-4 inline-block text-cyan-300 underline"
        to={`/checkout/${ticket.bookingId}`}
      >
        View booking
      </Link>
    </li>
  );
}

function TicketQr({ token }: { token: string }) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(token, { width: 256, margin: 4 })
      .then((data) => {
        if (active) setImage(data);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not generate ticket QR code',
          );
      });
    return () => {
      active = false;
    };
  }, [token]);
  if (error)
    return (
      <p className="mt-4 text-rose-300" role="alert">
        {error}
      </p>
    );
  return image ? (
    <img
      className="mt-4 max-w-full rounded"
      alt="Ticket QR code for organizer check-in"
      src={image}
      width={256}
      height={256}
    />
  ) : (
    <p className="mt-4" role="status">
      Generating ticket QR code...
    </p>
  );
}
