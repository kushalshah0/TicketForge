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
  const [appearance, setAppearance] = useState<{
    theme: 'dark' | 'light';
    error?: string;
  }>(() => {
    try {
      const savedTheme = window.localStorage.getItem('ticketforge-theme');
      return {
        theme:
          savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark',
      };
    } catch {
      return {
        theme: 'dark',
        error: 'Could not load your saved appearance. Using dark mode.',
      };
    }
  });
  const { theme, error: themeError } = appearance;
  const navigate = useNavigate();

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    try {
      window.localStorage.setItem('ticketforge-theme', nextTheme);
      setAppearance({ theme: nextTheme });
    } catch {
      setAppearance({
        theme: nextTheme,
        error: 'Appearance changed for now, but could not be saved.',
      });
    }
  }

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
    <div
      className="app-shell min-h-screen bg-slate-950 text-slate-100"
      data-theme={theme}
    >
      <header className="border-b border-slate-800">
        <nav className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Link
            className="text-xl font-semibold tracking-tight text-cyan-300"
            to="/"
          >
            TicketForge<span className="text-slate-400">.</span>
          </Link>
          <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 text-sm text-slate-300 sm:w-auto">
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
            <button
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="theme-toggle ml-auto flex h-11 w-11 items-center justify-center p-0 sm:ml-0"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
              >
                {theme === 'dark' ? (
                  <>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                  </>
                ) : (
                  <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.463.402.807a6.5 6.5 0 0 0 8.268 8.268c.344-.215.829-.003.803.397Z" />
                )}
              </svg>
            </button>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        {(error || logoutError) && (
          <p
            className="mb-6 rounded-lg border border-rose-900 bg-rose-950/50 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            {error ?? logoutError}
          </p>
        )}
        {themeError && (
          <p
            className="mb-6 rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200"
            role="status"
          >
            {themeError}
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
    <section className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
      <div>
        <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
          Make a night of it
        </p>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
          Find your next live moment.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
          Discover events, reserve the seats you want, and keep every ticket in
          one place.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="primary-button rounded-full px-6 py-3" to="/events">
            Explore events
          </Link>
          {!sessionName && (
            <Link
              className="secondary-button rounded-full px-6 py-3"
              to="/register"
            >
              Create an account
            </Link>
          )}
        </div>
        {loading && (
          <p className="mt-6 text-sm text-slate-400" role="status">
            Restoring your session…
          </p>
        )}
        {sessionName && (
          <p className="mt-6 text-sm text-slate-300">
            Welcome back, {sessionName}.
          </p>
        )}
      </div>
      <aside className="home-feature rounded-[2rem] border border-slate-800 p-6 sm:p-8 lg:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
          Your next plan
        </p>
        <div className="my-10 border-y border-slate-800 py-8 sm:my-12">
          <p className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Find something worth looking forward to.
          </p>
          <p className="mt-4 leading-7 text-slate-400">
            Search by event or city, then choose from live seat availability.
          </p>
        </div>
        <Link
          className="inline-flex items-center gap-2 text-sm font-medium text-cyan-300 hover:text-cyan-200"
          to="/events"
        >
          Browse events <span aria-hidden="true">→</span>
        </Link>
      </aside>
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
