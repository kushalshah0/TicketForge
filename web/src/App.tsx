import { useState } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { LoginPage, RegisterPage } from './AuthPages';
import { EventDetailPage, EventsPage } from './EventsPage';
import { CheckoutPage } from './CheckoutPage';
import { BookingsPage, TicketsPage } from './CustomerPages';
import { CheckInPage, OrganizerEventsPage } from './OrganizerPages';
import { useAuth } from './auth';
import { canAccessRole } from './roles';

export function App() {
  const { session, loading, error, logout: endSession } = useAuth();
  const [logoutError, setLogoutError] = useState<string>();
  const navigate = useNavigate();

  async function signOut() {
    setLogoutError(undefined);
    try {
      await endSession();
      navigate('/', { replace: true });
    } catch (signOutError: unknown) {
      setLogoutError(
        signOutError instanceof Error
          ? signOutError.message
          : 'Could not sign out',
      );
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link
            className="text-xl font-semibold tracking-tight text-cyan-300"
            to="/"
          >
            TicketForge
          </Link>
          <div className="flex items-center gap-5 text-sm text-slate-300">
            <Link to="/events">Events</Link>
            {session?.user.role === 'customer' && (
              <>
                <Link to="/bookings">My bookings</Link>
                <Link to="/tickets">My tickets</Link>
              </>
            )}
            {session?.user.role === 'organizer' && (
              <Link to="/organizer/events">Organizer</Link>
            )}
            {!loading && !session && (
              <>
                <Link to="/login">Sign in</Link>
                <Link className="text-cyan-300" to="/register">
                  Create account
                </Link>
              </>
            )}
            {session && (
              <button
                className="text-slate-300 hover:text-white"
                onClick={() => void signOut()}
                type="button"
              >
                Sign out
              </button>
            )}
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-14">
        {(error || logoutError) && (
          <p
            className="mb-6 rounded-lg border border-rose-900 bg-rose-950/50 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            {error ?? logoutError}
          </p>
        )}
        <Routes>
          <Route
            path="/"
            element={
              <Home loading={loading} sessionName={session?.user.displayName} />
            }
          />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/events/:eventId" element={<EventDetailPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<RequireRole role="customer" loading={loading} />}>
            <Route
              path="/bookings"
              element={<BookingsPage key={session?.user.id} />}
            />
            <Route
              path="/tickets"
              element={<TicketsPage key={session?.user.id} />}
            />
            <Route path="/checkout/:bookingId" element={<CheckoutPage />} />
          </Route>
          <Route element={<RequireRole role="organizer" loading={loading} />}>
            <Route
              path="/organizer/events"
              element={<OrganizerEventsPage key={session?.user.id} />}
            />
            <Route
              path="/organizer/checkin"
              element={<CheckInPage key={session?.user.id} />}
            />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function RequireRole({
  role,
  loading,
}: {
  role: 'customer' | 'organizer';
  loading: boolean;
}) {
  const { session } = useAuth();
  const location = useLocation();
  if (loading) return <p className="text-slate-400">Restoring your session…</p>;
  if (!session) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  if (!canAccessRole(session, role)) return <Navigate to="/" replace />;
  return <Outlet />;
}

function Home({
  loading,
  sessionName,
}: {
  loading: boolean;
  sessionName?: string;
}) {
  return (
    <section className="max-w-2xl">
      <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
        Events, made simple
      </p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Find your next live moment.
      </h1>
      <p className="mt-5 text-lg leading-8 text-slate-400">
        Discover events, reserve seats, and keep your tickets in one place.
      </p>
      {loading && (
        <p className="mt-8 text-sm text-slate-400">Restoring your session…</p>
      )}
      {sessionName && (
        <p className="mt-8 text-sm text-slate-300">
          Signed in as {sessionName}.
        </p>
      )}
    </section>
  );
}

function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link className="mt-4 inline-block text-cyan-300" to="/">
        Return home
      </Link>
    </section>
  );
}
