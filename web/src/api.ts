export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'customer' | 'organizer';
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  displayName: string;
  role: AuthUser['role'];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends Omit<
  RequestInit,
  'body' | 'headers'
> {
  body?: unknown;
  headers?: HeadersInit;
  idempotencyKey?: string;
}

let accessToken: string | undefined;
let refreshPromise: Promise<AuthSession | null> | undefined;

export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}

export async function login(input: LoginInput): Promise<AuthSession> {
  return establishSession('/api/auth/login', input);
}

export async function register(input: RegisterInput): Promise<AuthSession> {
  return establishSession('/api/auth/register', input);
}

export async function logout(): Promise<void> {
  try {
    await apiRequest<void>('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-Requested-With': 'TicketForge' },
    });
  } finally {
    setAccessToken(undefined);
  }
}

export async function refreshSession(): Promise<AuthSession | null> {
  if (!refreshPromise) {
    refreshPromise = requestRefresh().finally(() => {
      refreshPromise = undefined;
    });
  }
  return refreshPromise;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  if (!path.startsWith('/api/'))
    throw new Error('API requests must use a same-origin /api path');

  const failedWithToken = accessToken;
  let response = await sendRequest(path, options, failedWithToken);
  if (
    response.status === 401 &&
    failedWithToken &&
    !path.startsWith('/api/auth/')
  ) {
    const currentSession =
      accessToken !== failedWithToken && accessToken
        ? { accessToken }
        : await refreshSession();
    if (currentSession) {
      response = await sendRequest(path, options, currentSession.accessToken);
    }
  }
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function requestRefresh(): Promise<AuthSession | null> {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'TicketForge' },
  });
  if (response.status === 401) {
    setAccessToken(undefined);
    return null;
  }
  if (!response.ok) throw await toApiError(response);

  const session = parseSession(await response.json(), response.status);
  setAccessToken(session.accessToken);
  return session;
}

async function establishSession(
  path: '/api/auth/login' | '/api/auth/register',
  input: LoginInput | RegisterInput,
): Promise<AuthSession> {
  const value = await apiRequest<unknown>(path, {
    method: 'POST',
    body: input,
  });
  const session = parseSession(value, 200);
  setAccessToken(session.accessToken);
  return session;
}

async function sendRequest(
  path: string,
  options: ApiRequestOptions,
  token: string | undefined,
): Promise<Response> {
  const {
    body,
    headers: suppliedHeaders,
    idempotencyKey,
    ...requestOptions
  } = options;
  const headers = new Headers(suppliedHeaders);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

  let serializedBody: BodyInit | undefined;
  if (body !== undefined) {
    headers.set(
      'Content-Type',
      headers.get('Content-Type') ?? 'application/json',
    );
    serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
  }

  return fetch(path, {
    ...requestOptions,
    body: serializedBody,
    credentials: 'include',
    headers,
  });
}

function parseSession(value: unknown, status: number): AuthSession {
  if (
    !value ||
    typeof value !== 'object' ||
    !('user' in value) ||
    !('accessToken' in value)
  ) {
    throw new ApiError(status, 'The authentication response is malformed');
  }
  const session = value;
  if (
    typeof session.accessToken !== 'string' ||
    !session.user ||
    typeof session.user !== 'object' ||
    !('id' in session.user) ||
    !('email' in session.user) ||
    !('displayName' in session.user) ||
    !('role' in session.user)
  ) {
    throw new ApiError(status, 'The authentication response is malformed');
  }
  const user = session.user;
  if (
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    typeof user.displayName !== 'string' ||
    (user.role !== 'customer' && user.role !== 'organizer')
  ) {
    throw new ApiError(status, 'The authentication response is malformed');
  }
  return {
    accessToken: session.accessToken,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/problem+json') && body) {
    try {
      const value: unknown = JSON.parse(body);
      if (value && typeof value === 'object') {
        const problem = value as Record<string, unknown>;
        return new ApiError(
          response.status,
          typeof problem.detail === 'string'
            ? problem.detail
            : typeof problem.title === 'string'
              ? problem.title
              : response.statusText || `Request failed (${response.status})`,
          typeof problem.code === 'string' ? problem.code : undefined,
        );
      }
    } catch {
      return new ApiError(response.status, body);
    }
  }
  return new ApiError(
    response.status,
    body || response.statusText || `Request failed (${response.status})`,
  );
}
