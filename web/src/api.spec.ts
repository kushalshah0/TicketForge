import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  apiRequest,
  login,
  logout,
  refreshSession,
  register,
  setAccessToken,
} from './api';

afterEach(() => {
  setAccessToken(undefined);
  jest.restoreAllMocks();
});

describe('web API client', () => {
  it('uses one cookie refresh for concurrent unauthorized requests', async () => {
    let finishRefresh: (() => void) | undefined;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const session = {
      user: {
        id: 'user-1',
        email: 'customer@example.test',
        displayName: 'Customer',
        role: 'customer',
      },
      accessToken: 'new-access-token',
    };
    let refreshCalls = 0;
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        if (url === '/api/auth/refresh') {
          refreshCalls += 1;
          markRefreshStarted?.();
          await refreshGate;
          expect(init?.credentials).toBe('include');
          expect(new Headers(init?.headers).get('X-Requested-With')).toBe(
            'TicketForge',
          );
          return Response.json(session);
        }
        if (
          new Headers(init?.headers).get('Authorization') ===
          'Bearer new-access-token'
        ) {
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 401 });
      });
    setAccessToken('expired-access-token');

    const firstRequest = apiRequest<{ ok: boolean }>('/api/events');
    const secondRequest = apiRequest<{ ok: boolean }>('/api/tickets');
    await refreshStarted;
    finishRefresh?.();
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    expect(refreshCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('restores an in-memory session from the refresh cookie and sends idempotency keys', async () => {
    const session = {
      user: {
        id: 'user-2',
        email: 'returning@example.test',
        displayName: 'Returning Customer',
        role: 'customer',
      },
      accessToken: 'restored-access-token',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json({ bookingId: 'booking-1' }));

    await expect(refreshSession()).resolves.toEqual(session);
    await expect(
      apiRequest('/api/bookings', {
        method: 'POST',
        body: { eventId: 'event-1', seatIds: ['A1'] },
        idempotencyKey: 'booking-attempt-1',
      }),
    ).resolves.toEqual({ bookingId: 'booking-1' });

    const refreshInit = fetchMock.mock.calls[0]?.[1];
    expect(refreshInit?.credentials).toBe('include');
    expect(new Headers(refreshInit?.headers).get('X-Requested-With')).toBe(
      'TicketForge',
    );
    const bookingInit = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(bookingInit?.headers).get('Authorization')).toBe(
      'Bearer restored-access-token',
    );
    expect(new Headers(bookingInit?.headers).get('Idempotency-Key')).toBe(
      'booking-attempt-1',
    );
    expect(bookingInit?.body).toBe(
      JSON.stringify({ eventId: 'event-1', seatIds: ['A1'] }),
    );
  });

  it('parses problem details into a typed API error', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 409,
          detail: 'Seat is unavailable',
          code: 'SEAT_UNAVAILABLE',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );

    await expect(apiRequest('/api/bookings')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'SEAT_UNAVAILABLE',
      message: 'Seat is unavailable',
    });
  });

  it('uses the problem title when its detail is absent', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 404,
          title: 'Not Found',
        }),
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );

    await expect(apiRequest('/api/events/missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Not Found',
    });
  });

  it('starts login and registration sessions without persisting access tokens', async () => {
    const session = {
      user: {
        id: 'user-3',
        email: 'new@example.test',
        displayName: 'New Customer',
        role: 'customer',
      },
      accessToken: 'session-access-token',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      login({ email: session.user.email, password: 'long-enough-password' }),
    ).resolves.toEqual(session);
    await expect(
      register({
        email: session.user.email,
        displayName: session.user.displayName,
        password: 'long-enough-password',
        role: 'customer',
      }),
    ).resolves.toEqual(session);
    await apiRequest('/api/events');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/login');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/register');
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer session-access-token');
    expect(globalThis.localStorage).toBeUndefined();
  });

  it('sends the logout CSRF header and clears the in-memory token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    setAccessToken('access-token');

    await logout();
    await apiRequest('/api/events');

    const logoutInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(logoutInit?.headers).get('X-Requested-With')).toBe(
      'TicketForge',
    );
    expect(new Headers(logoutInit?.headers).get('Authorization')).toBe(
      'Bearer access-token',
    );
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has('Authorization'),
    ).toBe(false);
  });
});
