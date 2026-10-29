import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';

export function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await login({ email, password });
      const state: unknown = location.state;
      const from =
        state &&
        typeof state === 'object' &&
        'from' in state &&
        typeof state.from === 'string'
          ? state.from
          : '/';
      navigate(from, { replace: true });
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not sign in',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to manage your TicketForge account."
    >
      <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm text-slate-300">
          Email
          <input
            autoComplete="email"
            className="form-input"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="block text-sm text-slate-300">
          Password
          <input
            autoComplete="current-password"
            className="form-input"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {error && (
          <p className="text-sm text-rose-300" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button w-full"
          disabled={submitting}
          type="submit"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-6 text-sm text-slate-400">
        New here?{' '}
        <Link className="text-cyan-300 hover:text-cyan-200" to="/register">
          Create an account
        </Link>
      </p>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { session, register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'customer' | 'organizer'>('customer');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await register({ displayName, email, password, role });
      navigate('/', { replace: true });
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not create your account',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Choose how you want to use TicketForge."
    >
      <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm text-slate-300">
          Name
          <input
            autoComplete="name"
            className="form-input"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
        </label>
        <label className="block text-sm text-slate-300">
          Email
          <input
            autoComplete="email"
            className="form-input"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="block text-sm text-slate-300">
          Password
          <input
            autoComplete="new-password"
            className="form-input"
            minLength={10}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Use at least 10 characters.
          </span>
        </label>
        <label className="block text-sm text-slate-300">
          Account type
          <select
            className="form-input"
            onChange={(event) =>
              setRole(
                event.target.value === 'organizer' ? 'organizer' : 'customer',
              )
            }
            value={role}
          >
            <option value="customer">Customer</option>
            <option value="organizer">Organizer</option>
          </select>
        </label>
        {error && (
          <p className="text-sm text-rose-300" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button w-full"
          disabled={submitting}
          type="submit"
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="mt-6 text-sm text-slate-400">
        Already registered?{' '}
        <Link className="text-cyan-300 hover:text-cyan-200" to="/login">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
      <h1 className="text-2xl font-semibold text-white">{title}</h1>
      <p className="mb-8 mt-2 text-sm text-slate-400">{subtitle}</p>
      {children}
    </section>
  );
}
