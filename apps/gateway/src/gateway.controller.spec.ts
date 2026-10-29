import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  DomainError,
  type AuthenticatedUser,
  JwtAuthGuard,
  runWithCorrelationId,
} from '@tf/common';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { GatewayService, resolveGatewayRoute } from './gateway.service';

describe('GatewayService routing', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['POST', '/api/auth/register', 'auth', undefined],
    ['POST', '/api/auth/login', 'auth', undefined],
    ['POST', '/api/auth/refresh', 'auth', undefined],
    ['POST', '/api/auth/logout', 'auth', 'any'],
    ['GET', '/api/auth/me', 'auth', 'any'],
    ['GET', '/api/events', 'catalog', undefined],
    ['GET', '/api/events/event-id', 'catalog', undefined],
    ['GET', '/api/events/event-id/availability', 'booking', undefined],
    ['POST', '/api/events', 'catalog', 'organizer'],
    ['PATCH', '/api/events/event-id', 'catalog', 'organizer'],
    ['POST', '/api/events/event-id/publish', 'catalog', 'organizer'],
    ['POST', '/api/events/event-id/cancel', 'catalog', 'organizer'],
    ['GET', '/api/organizer/events', 'catalog', 'organizer'],
    ['POST', '/api/bookings', 'booking', 'customer'],
    ['GET', '/api/tickets', 'booking', 'customer'],
    ['GET', '/api/tickets/ticket-id', 'booking', 'customer'],
    ['POST', '/api/checkin', 'booking', 'organizer'],
    ['POST', '/api/payments', 'payment', 'customer'],
  ] as const)('%s %s routes to %s', (method, path, service, role) => {
    expect(resolveGatewayRoute(method, path)).toEqual({
      service,
      ...(role ? { role } : {}),
    });
  });

  it.each([
    ['/api/metrics', 'GET'],
    ['/api/internal/status', 'GET'],
    ['/api/payments/webhook', 'POST'],
    ['/api/not-a-route', 'GET'],
    ['/api/auth/login', 'GET'],
  ])('does not expose %s', (path, method) => {
    expect(resolveGatewayRoute(method, path)).toBeUndefined();
  });

  it('strips /api and forwards query, auth, request ID, body, and response', async () => {
    const upstream = new Response(JSON.stringify({ userId: 'user-1' }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'refresh_token=value',
      },
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream);
    const setHeader = jest.fn();
    const status = jest.fn().mockReturnThis();
    const send = jest.fn();
    const response = { setHeader, status, send } as unknown as Response;
    const request = {
      method: 'POST',
      originalUrl: '/api/auth/register?from=web',
      headers: {
        authorization: 'Bearer access-token',
        'content-type': 'application/json',
        'x-request-id': 'request-1',
      },
      body: { email: 'ada@example.com' },
    } as unknown as Request;
    const service = new GatewayService();

    await service.forward(request, response);

    const [target, options] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(options?.headers);
    expect(target).toEqual(
      new URL('http://127.0.0.1:3001/auth/register?from=web'),
    );
    expect(options).toMatchObject({
      method: 'POST',
      body: JSON.stringify(request.body),
    });
    expect(forwardedHeaders.get('authorization')).toBe('Bearer access-token');
    expect(forwardedHeaders.get('x-request-id')).toBe('request-1');
    expect(status.mock.calls[0]).toEqual([201]);
    expect(setHeader.mock.calls).toContainEqual([
      'set-cookie',
      'refresh_token=value',
    ]);
    expect(send.mock.calls[0]).toEqual([
      Buffer.from(JSON.stringify({ userId: 'user-1' })),
    ]);
  });

  it('authenticates protected routes and enforces their configured role', async () => {
    const request = {
      method: 'POST',
      originalUrl: '/api/bookings',
      headers: { authorization: 'Bearer token' },
    } as unknown as Request & { user?: AuthenticatedUser };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    const jwtAuthGuard = new JwtAuthGuard();
    const authenticate = jest
      .spyOn(jwtAuthGuard, 'canActivate')
      .mockImplementation(() =>
        Promise.resolve().then(() => {
          request.user = { sub: 'user-1', role: 'organizer' };
          return true;
        }),
      );
    const guard = new GatewayAuthGuard(jwtAuthGuard);

    await expect(guard.canActivate(context)).rejects.toMatchObject<
      Partial<DomainError>
    >({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(authenticate).toHaveBeenCalledWith(context);
  });

  it('does not authenticate public routes', async () => {
    const request = {
      method: 'POST',
      originalUrl: '/api/auth/login',
      headers: {},
    } as unknown as Request;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    const jwtAuthGuard = new JwtAuthGuard();
    const authenticate = jest
      .spyOn(jwtAuthGuard, 'canActivate')
      .mockResolvedValue(true);
    const guard = new GatewayAuthGuard(jwtAuthGuard);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('retries failed GET requests once within the upstream timeout', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;
    const request = {
      method: 'GET',
      originalUrl: '/api/events',
      headers: {},
    } as unknown as Request;

    await new GatewayService().forward(request, response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(
      fetchMock.mock.calls[0]?.[1]?.signal,
    );
  });

  it('returns a service-unavailable error without retrying failed writes', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('offline'));
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;
    const request = {
      method: 'POST',
      originalUrl: '/api/auth/register',
      headers: {},
      body: { email: 'ada@example.com' },
    } as unknown as Request;

    await expect(
      new GatewayService().forward(request, response),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { 'x-request-id': 'incoming-id' }])(
    'forwards the active correlation ID instead of an absent or stale header: %j',
    async (headers) => {
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new globalThis.Response('ok'));
      const response = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      } as unknown as Response;
      const request = {
        method: 'GET',
        originalUrl: '/api/events',
        headers,
      } as Request;
      await runWithCorrelationId('active-id', () =>
        new GatewayService().forward(request, response),
      );
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-request-id'),
      ).toBe('active-id');
    },
  );
});
