import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  register as registerRequest,
  type AuthSession,
  type LoginInput,
  type RegisterInput,
} from './api';

interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  error?: string;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void refreshSession()
      .then((currentSession) => {
        if (active) setSession(currentSession);
      })
      .catch((refreshError: unknown) => {
        if (active) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : 'Could not restore your session',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function login(input: LoginInput): Promise<void> {
    setError(undefined);
    setSession(await loginRequest(input));
  }

  async function register(input: RegisterInput): Promise<void> {
    setError(undefined);
    setSession(await registerRequest(input));
  }

  async function logout(): Promise<void> {
    try {
      await logoutRequest();
    } finally {
      setSession(null);
    }
  }

  return (
    <AuthContext.Provider
      value={{ session, loading, error, login, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
