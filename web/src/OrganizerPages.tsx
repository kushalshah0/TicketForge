import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from './auth';
import {
  changeEventStatus,
  checkInErrorMessage,
  checkInTicket,
  createOrganizerEvent,
  listOrganizerEvents,
  type OrganizerEvent,
} from './organizer';
import { TicketScanner } from './TicketScanner';

export function OrganizerEventsPage() {
  const { session } = useAuth();
  const events = useQuery({
    queryKey: ['organizer-events', session?.user.id],
    queryFn: listOrganizerEvents,
    enabled: Boolean(session),
  });
  return (
    <section>
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
        Organizer workspace
      </p>
      <h1 className="text-4xl font-semibold tracking-tight">
        Your events, in one place.
      </h1>
      <Link
        className="secondary-button mt-5 rounded-full"
        to="/organizer/checkin"
      >
        Check in a ticket
      </Link>
      <EventForm />
      {events.isPending ? (
        <p className="mt-6" role="status">
          Loading events...
        </p>
      ) : events.isError ? (
        <div className="mt-6" role="alert">
          <p>{events.error.message}</p>
          <button
            className="mt-3 underline"
            onClick={() => void events.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <ul className="mt-8 space-y-4">
          {events.data.length === 0 && (
            <li>No events yet. Create your first event above.</li>
          )}
          {events.data.map((event) => (
            <OrganizerEventCard event={event} key={event.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OrganizerEventCard({ event }: { event: OrganizerEvent }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<'publish' | 'cancel'>();
  const changeStatus = useMutation({
    mutationFn: (action: 'publish' | 'cancel') =>
      changeEventStatus(event.id, action),
    onSuccess: () => {
      setConfirmation(undefined);
      void queryClient.invalidateQueries({
        queryKey: ['organizer-events', session?.user.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['event', event.id] });
    },
  });
  return (
    <li className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
      <h2 className="text-xl font-semibold">{event.title}</h2>
      <p className="mt-2">
        {event.venueName}, {event.city} -{' '}
        {new Date(event.startsAt).toLocaleString()}
      </p>
      <p className="mt-3 inline-flex rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-cyan-300">
        {event.status}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {event.status === 'PUBLISHED' && (
          <Link className="underline" to={`/events/${event.id}`}>
            Public event
          </Link>
        )}
        {event.status === 'DRAFT' && (
          <button
            className="primary-button"
            onClick={() => setConfirmation('publish')}
            type="button"
          >
            Publish
          </button>
        )}
        {event.status !== 'CANCELLED' && (
          <button
            className="secondary-button border-rose-900 text-rose-300 hover:border-rose-700"
            onClick={() => setConfirmation('cancel')}
            type="button"
          >
            Cancel event
          </button>
        )}
      </div>
      {confirmation && (
        <div className="mt-5 rounded-xl border border-amber-800 bg-amber-950/40 p-4">
          <p>
            {confirmation === 'publish'
              ? 'Publish this event? Its seat layout and prices cannot be edited after publishing.'
              : 'Cancel this event? Bookings will be cancelled, tickets voided, and refunds requested.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className="primary-button"
              disabled={changeStatus.isPending}
              onClick={() => changeStatus.mutate(confirmation)}
              type="button"
            >
              {changeStatus.isPending ? 'Saving...' : `Confirm ${confirmation}`}
            </button>
            <button
              className="secondary-button"
              disabled={changeStatus.isPending}
              onClick={() => setConfirmation(undefined)}
              type="button"
            >
              Go back
            </button>
          </div>
        </div>
      )}
      {changeStatus.isError && (
        <p className="mt-3 text-rose-300" role="alert">
          {changeStatus.error.message}
        </p>
      )}
    </li>
  );
}

interface FormSection {
  id: string;
  tierId: string;
  name: string;
  tierName: string;
  rows: number;
  seatsPerRow: number;
  priceMinor: number;
}

function newSection(): FormSection {
  return {
    id: crypto.randomUUID(),
    tierId: crypto.randomUUID(),
    name: '',
    tierName: '',
    rows: 1,
    seatsPerRow: 10,
    priceMinor: 0,
  };
}

function EventForm() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [sections, setSections] = useState<FormSection[]>(() => [newSection()]);
  const createEvent = useMutation({
    mutationFn: createOrganizerEvent,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['organizer-events', session?.user.id],
      });
    },
  });
  const seatCount = sections.reduce(
    (total, section) => total + section.rows * section.seatsPerRow,
    0,
  );

  function updateSection(index: number, change: Partial<FormSection>) {
    setSections((current) =>
      current.map((section, itemIndex) =>
        itemIndex === index ? { ...section, ...change } : section,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const startsAt = data.get('startsAt');
    createEvent.mutate(
      {
        title: data.get('title'),
        description: data.get('description'),
        venueName: data.get('venueName'),
        city: data.get('city'),
        startsAt:
          typeof startsAt === 'string' ? new Date(startsAt).toJSON() : null,
        currency: data.get('currency'),
        layout: {
          sections: sections.map(({ id, name, tierId, rows, seatsPerRow }) => ({
            id,
            name,
            tierId,
            rows,
            seatsPerRow,
          })),
        },
        tiers: sections.map(({ tierId, tierName, priceMinor }) => ({
          id: tierId,
          name: tierName,
          priceMinor,
        })),
      },
      {
        onSuccess: () => {
          form.reset();
          setSections([newSection()]);
        },
      },
    );
  }

  return (
    <form
      className="mt-8 space-y-5 rounded-3xl border border-slate-800 bg-slate-900 p-5 sm:p-7"
      onSubmit={submit}
    >
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Start here
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">
          Create event draft
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          Title
          <input className="form-input" name="title" required maxLength={200} />
        </label>
        <label>
          Venue
          <input
            className="form-input"
            name="venueName"
            required
            maxLength={200}
          />
        </label>
        <label>
          City
          <input className="form-input" name="city" required maxLength={120} />
        </label>
        <label>
          Starts at (your local time)
          <input
            className="form-input"
            name="startsAt"
            type="datetime-local"
            required
          />
        </label>
        <label>
          Currency
          <input
            className="form-input"
            name="currency"
            defaultValue="NPR"
            pattern="[A-Z]{3}"
            maxLength={3}
            required
          />
        </label>
      </div>
      <label className="block">
        Description
        <textarea className="form-input" name="description" maxLength={10000} />
      </label>
      <p
        className={seatCount > 500 ? 'text-rose-300' : 'text-slate-300'}
        aria-live="polite"
      >
        Total seats: {seatCount} / 500. Prices are whole minor units (for NPR,
        100 = NPR 1).
      </p>
      {sections.map((section, index) => (
        <fieldset
          className="grid gap-3 rounded-2xl border border-slate-700 p-4 sm:grid-cols-2 sm:p-5"
          key={section.id}
        >
          <legend>Section {index + 1}</legend>
          <label>
            Name
            <input
              className="form-input"
              value={section.name}
              onChange={(event) =>
                updateSection(index, { name: event.target.value })
              }
              required
            />
          </label>
          <label>
            Tier name
            <input
              className="form-input"
              value={section.tierName}
              onChange={(event) =>
                updateSection(index, { tierName: event.target.value })
              }
              required
            />
          </label>
          <label>
            Rows (1-26)
            <input
              className="form-input"
              type="number"
              min={1}
              max={26}
              step={1}
              value={section.rows}
              onChange={(event) =>
                updateSection(index, { rows: event.target.valueAsNumber })
              }
              required
            />
          </label>
          <label>
            Seats per row (1-40)
            <input
              className="form-input"
              type="number"
              min={1}
              max={40}
              step={1}
              value={section.seatsPerRow}
              onChange={(event) =>
                updateSection(index, {
                  seatsPerRow: event.target.valueAsNumber,
                })
              }
              required
            />
          </label>
          <label>
            Price in minor units
            <input
              className="form-input"
              type="number"
              min={0}
              step={1}
              value={section.priceMinor}
              onChange={(event) =>
                updateSection(index, { priceMinor: event.target.valueAsNumber })
              }
              required
            />
          </label>
          <button
            className="secondary-button"
            disabled={sections.length === 1}
            onClick={() =>
              setSections((current) =>
                current.filter((item) => item.id !== section.id),
              )
            }
            type="button"
          >
            Remove section {index + 1}
          </button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-3">
        <button
          className="secondary-button"
          onClick={() => setSections((current) => [...current, newSection()])}
          type="button"
        >
          Add section
        </button>
        <button
          className="primary-button"
          disabled={createEvent.isPending || seatCount > 500}
          type="submit"
        >
          {createEvent.isPending ? 'Creating...' : 'Create draft'}
        </button>
      </div>
      {createEvent.isError && (
        <p className="text-rose-300" role="alert">
          {createEvent.error.message}
        </p>
      )}
      {createEvent.isSuccess && (
        <p className="text-emerald-300" role="status">
          Draft created. Use Publish in the event list when ready.
        </p>
      )}
    </form>
  );
}

export function CheckInPage() {
  const [token, setToken] = useState('');
  const checkIn = useMutation({ mutationFn: checkInTicket, retry: false });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    checkIn.mutate(token);
  }
  return (
    <section className="mx-auto max-w-xl rounded-3xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
        At the door
      </p>
      <h1 className="text-4xl font-semibold tracking-tight">Ticket check-in</h1>
      <Link
        className="mt-4 inline-block text-sm text-cyan-300 underline"
        to="/organizer/events"
      >
        Back to organizer events
      </Link>
      <TicketScanner
        disabled={checkIn.isPending}
        onScan={(value) => {
          setToken(value);
          checkIn.mutate(value);
        }}
      />
      <form className="mt-6 space-y-5" onSubmit={submit}>
        <label className="block">
          Ticket token
          <textarea
            className="form-input"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </label>
        <button
          className="primary-button w-full"
          disabled={checkIn.isPending || !token.trim()}
          type="submit"
        >
          {checkIn.isPending ? 'Checking...' : 'Check in ticket'}
        </button>
      </form>
      {checkIn.isSuccess && (
        <div className="mt-5 text-emerald-300" role="status">
          <p>Checked in successfully. Seat: {checkIn.data.seatId}</p>
          <p>Used at: {new Date(checkIn.data.usedAt).toLocaleString()}</p>
        </div>
      )}
      {checkIn.isError && (
        <p className="mt-5 text-rose-300" role="alert">
          {checkInErrorMessage(checkIn.error)}
        </p>
      )}
    </section>
  );
}
