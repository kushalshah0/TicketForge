import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, createIdempotencyKey } from './api';
import { useAuth } from './auth';
import {
  createBookingHold,
  EVENTS_PAGE_SIZE,
  formatMinorCurrency,
  getEventAvailability,
  getEvent,
  keepAvailableSelections,
  listEvents,
  priceForSeat,
  readEventFilters,
  serializeEventFilters,
  toggleSeatSelection,
} from './events';
import type { BookingHold, CatalogEvent, EventAvailability } from './events';

export function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readEventFilters(searchParams.toString());
  const [q, setQ] = useState(filters.q);
  const [city, setCity] = useState(filters.city);
  const events = useQuery({
    queryKey: ['events', filters],
    queryFn: () => listEvents(filters),
  });

  useEffect(() => {
    setQ(filters.q);
    setCity(filters.city);
  }, [filters.q, filters.city]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchParams(serializeEventFilters({ q, city, page: 0 }));
  }

  function changePage(page: number) {
    setSearchParams(serializeEventFilters({ ...filters, page }));
  }

  return (
    <section>
      <div className="mb-9 max-w-2xl">
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
          The lineup
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Find your next event.
        </h1>
        <p className="mt-4 text-lg leading-8 text-slate-400">
          Search by event or city and find the seats that make the night yours.
        </p>
      </div>

      <form
        className="mb-8 grid gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end sm:p-6"
        onSubmit={submitSearch}
      >
        <label className="block text-sm text-slate-300">
          Search events
          <input
            className="form-input"
            onChange={(event) => setQ(event.target.value)}
            placeholder="Title or city"
            type="search"
            value={q}
          />
        </label>
        <label className="block text-sm text-slate-300">
          City
          <input
            className="form-input"
            onChange={(event) => setCity(event.target.value)}
            placeholder="Any city"
            value={city}
          />
        </label>
        <button className="primary-button w-full sm:w-auto" type="submit">
          Search
        </button>
      </form>

      {events.isPending ? (
        <EventListSkeleton />
      ) : events.isError ? (
        <div
          className="rounded-xl border border-rose-900 bg-rose-950/40 p-6"
          role="alert"
        >
          <p>{events.error.message || 'Could not load events.'}</p>
          <button
            className="mt-4 text-cyan-300 underline"
            onClick={() => void events.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : events.data.items.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-300">
          <p>
            {events.data.total > 0
              ? 'There are no events on this page.'
              : 'No events match those filters.'}
          </p>
          {filters.page > 0 && (
            <button
              className="mt-4 text-cyan-300 underline"
              onClick={() => changePage(filters.page - 1)}
              type="button"
            >
              Go to previous page
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {events.data.items.map((event) => (
              <EventCard
                event={event}
                key={event.id}
                search={searchParams.toString()}
              />
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-4 border-t border-slate-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-400">
              Showing {filters.page * EVENTS_PAGE_SIZE + 1}–
              {Math.min(
                (filters.page + 1) * EVENTS_PAGE_SIZE,
                events.data.total,
              )}{' '}
              of {events.data.total}
            </p>
            <div className="flex gap-3">
              <button
                className="secondary-button"
                disabled={filters.page === 0}
                onClick={() => changePage(filters.page - 1)}
                type="button"
              >
                Previous
              </button>
              <button
                className="secondary-button"
                disabled={
                  (filters.page + 1) * EVENTS_PAGE_SIZE >= events.data.total
                }
                onClick={() => changePage(filters.page + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function EventDetailPage() {
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const event = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId ?? ''),
    enabled: Boolean(eventId),
  });
  const backToEvents = searchParams.size
    ? `/events?${searchParams.toString()}`
    : '/events';

  if (event.isPending) {
    return (
      <div className="animate-pulse space-y-4" role="status">
        <span className="sr-only">Loading event…</span>
        <div className="h-5 w-32 rounded bg-slate-800" />
        <div className="h-10 w-2/3 rounded bg-slate-800" />
        <div className="h-28 rounded bg-slate-800" />
      </div>
    );
  }

  if (event.isError) {
    const notFound =
      event.error instanceof ApiError && event.error.status === 404;
    return (
      <section>
        <p
          className="rounded-xl border border-rose-900 bg-rose-950/40 p-6 text-rose-200"
          role="alert"
        >
          {notFound
            ? 'Event not found.'
            : event.error.message || 'Could not load this event.'}
        </p>
        <Link
          className="mt-6 inline-block text-cyan-300 hover:text-cyan-200"
          to={backToEvents}
        >
          Back to events
        </Link>
      </section>
    );
  }

  return (
    <article>
      <Link
        className="text-sm text-cyan-300 hover:text-cyan-200"
        to={backToEvents}
      >
        ← Back to events
      </Link>
      <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-900 p-6 sm:p-10">
        <p className="text-sm font-medium text-cyan-300">{event.data.city}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {event.data.title}
        </h1>
        <p className="mt-4 text-slate-300">
          {event.data.venueName} ·{' '}
          <time dateTime={event.data.startsAt}>
            {formatEventDate(event.data.startsAt)}
          </time>
        </p>
        {event.data.description && (
          <p className="mt-8 whitespace-pre-wrap leading-7 text-slate-300">
            {event.data.description}
          </p>
        )}
        <div className="mt-8 border-t border-slate-800 pt-6">
          <h2 className="text-lg font-semibold">Ticket options</h2>
          {event.data.tiers.length > 0 ? (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {event.data.tiers.map((tier) => (
                <li
                  className="rounded-xl border border-slate-800 px-4 py-4"
                  key={tier.id}
                >
                  {tier.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-slate-400">
              Ticket options will be available soon.
            </p>
          )}
        </div>
        <EventBooking event={event.data} />
      </div>
    </article>
  );
}

function EventBooking({ event }: { event: CatalogEvent }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string>();
  const [holds, setHolds] = useState<BookingHold[]>([]);
  const [holdError, setHoldError] = useState<string>();
  const availability = useQuery({
    queryKey: ['event-availability', event.id],
    queryFn: () => getEventAvailability(event.id),
    refetchInterval: 5_000,
  });
  const booking = useMutation({
    mutationFn: ({
      seatIds,
      idempotencyKey,
    }: {
      seatIds: string[];
      idempotencyKey: string;
    }) => createBookingHold(event.id, seatIds, idempotencyKey),
    retry: (failureCount, error) =>
      error instanceof TypeError && failureCount < 1,
    onSuccess: (createdHold) => {
      setHolds((current) =>
        current.some(
          (currentHold) => currentHold.bookingId === createdHold.bookingId,
        )
          ? current
          : [...current, createdHold],
      );
      setSelectedSeatIds([]);
      setMessage(undefined);
      setHoldError(undefined);
      void queryClient.invalidateQueries({
        queryKey: ['event-availability', event.id],
      });
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'SEAT_UNAVAILABLE'
      ) {
        setSelectedSeatIds([]);
        setMessage(
          'Those seats were just reserved by someone else. Availability has been refreshed.',
        );
        void queryClient.invalidateQueries({
          queryKey: ['event-availability', event.id],
        });
      } else {
        setHoldError(
          error instanceof Error
            ? error.message
            : 'Could not reserve those seats.',
        );
      }
    },
  });

  useEffect(() => {
    if (!availability.data || selectedSeatIds.length === 0) return;
    const remaining = keepAvailableSelections(
      selectedSeatIds,
      availability.data,
    );
    if (remaining.length !== selectedSeatIds.length) {
      setSelectedSeatIds(remaining);
      setMessage('A selected seat is no longer available and was removed.');
    }
  }, [availability.data, selectedSeatIds]);

  function changeSeat(seatId: string) {
    setMessage(undefined);
    setHoldError(undefined);
    setSelectedSeatIds(
      (current) => toggleSeatSelection(current, seatId) ?? current,
    );
  }

  function reserveSeats() {
    if (selectedSeatIds.length === 0) return;
    setHoldError(undefined);
    booking.mutate({
      seatIds: selectedSeatIds,
      idempotencyKey: createIdempotencyKey(),
    });
  }

  const selectedTotal = selectedSeatIds.reduce(
    (sum, seatId) =>
      sum +
      (availability.data ? priceForSeat(event, availability.data, seatId) : 0),
    0,
  );

  return (
    <section className="mt-8 border-t border-slate-800 pt-7">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Choose seats</h2>
          <p className="mt-1 text-sm text-slate-400">
            Availability refreshes every 5 seconds. Select up to 6 seats.
          </p>
        </div>
        {availability.data && (
          <div
            aria-label="Seat availability legend"
            className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300"
          >
            <span>
              <i className="mr-1 inline-block size-3 rounded bg-emerald-700" />
              Available
            </span>
            <span>
              <i className="mr-1 inline-block size-3 rounded bg-cyan-500" />
              Selected
            </span>
            <span>
              <i className="mr-1 inline-block size-3 rounded bg-blue-700" />
              Your hold
            </span>
            <span>
              <i className="mr-1 inline-block size-3 rounded bg-amber-700" />
              Held
            </span>
            <span>
              <i className="mr-1 inline-block size-3 rounded bg-slate-700" />
              Sold / unavailable
            </span>
          </div>
        )}
      </div>

      {availability.isPending ? (
        <p className="mt-5 animate-pulse text-sm text-slate-400" role="status">
          Loading seat availability…
        </p>
      ) : availability.isError ? (
        <div
          className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200"
          role="alert"
        >
          <p>
            {availability.error.message || 'Could not load seat availability.'}
          </p>
          <button
            className="mt-3 underline"
            onClick={() => void availability.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {message && (
            <p
              className="mt-5 rounded-lg border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-200"
              role="status"
            >
              {message}
            </p>
          )}
          {holdError && (
            <p
              className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200"
              role="alert"
            >
              {holdError}
            </p>
          )}
          {holds.map((hold) => (
            <div
              className="mt-5 rounded-lg border border-emerald-800 bg-emerald-950/40 p-4 text-sm text-emerald-200"
              key={hold.bookingId}
              role="status"
            >
              <p>
                {hold.seatIds.length} seat(s) reserved until{' '}
                {new Date(hold.expiresAt).toLocaleTimeString()}.
              </p>
              <Link
                className="mt-2 inline-block font-medium underline"
                to={`/checkout/${hold.bookingId}`}
                state={{ booking: hold }}
              >
                Continue to checkout
              </Link>
            </div>
          ))}
          <SeatGrid
            availability={availability.data}
            event={event}
            mineSeatIds={holds.flatMap((hold) => hold.seatIds)}
            selectedSeatIds={selectedSeatIds}
            disabled={booking.isPending}
            onSelect={changeSeat}
          />
          {availability.data.sections.every(
            (section) => section.seats.length === 0,
          ) && (
            <p className="mt-5 text-sm text-slate-400">
              No seats are available for this event.
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 pt-5">
            <p className="text-slate-300" aria-live="polite">
              {selectedSeatIds.length} selected ·{' '}
              {formatMinorCurrency(selectedTotal, event.currency)}
            </p>
            {session?.user.role === 'customer' ? (
              <button
                className="primary-button"
                disabled={selectedSeatIds.length === 0 || booking.isPending}
                onClick={reserveSeats}
                type="button"
              >
                {booking.isPending ? 'Reserving…' : 'Reserve seats'}
              </button>
            ) : session?.user.role === 'organizer' ? (
              <p className="text-sm text-slate-400">
                Sign in with a customer account to reserve seats.
              </p>
            ) : (
              <Link
                className="primary-button"
                to="/login"
                state={{ from: `/events/${event.id}` }}
              >
                Sign in to reserve
              </Link>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SeatGrid({
  availability,
  event,
  mineSeatIds,
  selectedSeatIds,
  disabled,
  onSelect,
}: {
  availability: EventAvailability;
  event: CatalogEvent;
  mineSeatIds: string[];
  selectedSeatIds: string[];
  disabled: boolean;
  onSelect: (seatId: string) => void;
}) {
  const availabilityBySection = new Map(
    availability.sections.map((section) => [section.sectionId, section.seats]),
  );
  return (
    <div className="mt-5 space-y-5">
      {event.layout.sections.map((section) => {
        const seats = availabilityBySection.get(section.id) ?? [];
        const tier = event.tiers.find((item) => item.id === section.tierId);
        return (
          <section
            className="rounded-2xl border border-slate-800 p-4 sm:p-5"
            key={section.id}
          >
            <div className="mb-3 flex flex-wrap justify-between gap-2 text-sm">
              <h3 className="font-medium">{section.name}</h3>
              <p className="text-slate-400">
                {tier
                  ? `${tier.name} · ${formatMinorCurrency(tier.priceMinor, event.currency)}`
                  : 'Price unavailable'}
              </p>
            </div>
            {seats.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {seats.map((seat) => {
                  const selected = selectedSeatIds.includes(seat.seatId);
                  const available = seat.status === 'AVAILABLE';
                  const isMine =
                    seat.status === 'HELD' && mineSeatIds.includes(seat.seatId);
                  const statusLabel = selected
                    ? 'Selected'
                    : isMine
                      ? 'Your hold'
                      : seat.status === 'AVAILABLE'
                        ? 'Available'
                        : seat.status === 'HELD'
                          ? 'Held'
                          : seat.status === 'SOLD'
                            ? 'Sold'
                            : 'Unavailable';
                  return (
                    <button
                      aria-label={`${seat.seatId}, ${statusLabel}`}
                      aria-pressed={selected}
                      className={`min-h-11 min-w-11 rounded-xl px-2 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                        selected
                          ? 'bg-cyan-500 text-slate-950'
                          : isMine
                            ? 'bg-blue-700 text-white'
                            : available
                              ? 'bg-emerald-800 text-white hover:bg-emerald-700'
                              : seat.status === 'HELD'
                                ? 'cursor-not-allowed bg-amber-700 text-white'
                                : 'cursor-not-allowed bg-slate-800 text-slate-300'
                      }`}
                      disabled={!available || disabled}
                      key={seat.seatId}
                      onClick={() => onSelect(seat.seatId)}
                      type="button"
                    >
                      {seat.seatId}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Seat inventory is not available yet.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function EventCard({ event, search }: { event: CatalogEvent; search: string }) {
  const detailPath = `/events/${encodeURIComponent(event.id)}${search ? `?${search}` : ''}`;
  return (
    <Link
      className="group rounded-2xl border border-slate-800 bg-slate-900 p-6 transition duration-200 hover:-translate-y-0.5 hover:border-cyan-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:p-7"
      to={detailPath}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
        {event.city}
      </p>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">
        {event.title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-slate-400">
        {event.venueName} · {formatEventDate(event.startsAt)}
      </p>
      <span className="mt-7 inline-flex items-center gap-2 text-sm font-medium text-cyan-300 group-hover:text-cyan-200">
        View event <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}

function EventListSkeleton() {
  return (
    <div className="grid animate-pulse gap-4 md:grid-cols-2" role="status">
      <span className="sr-only">Loading events…</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          className="h-36 rounded-xl border border-slate-800 bg-slate-900"
          key={index}
        />
      ))}
    </div>
  );
}

function formatEventDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
