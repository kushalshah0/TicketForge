import { jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import {
  AuthService,
  type AuthSession,
  type LoginInput,
  type RegisterInput,
  type RequestMetadata,
} from './auth.service';

describe('AuthController', () => {
  const authService = {
    register:
      jest.fn<
        (
          input: RegisterInput,
          metadata: RequestMetadata,
        ) => Promise<AuthSession>
      >(),
    login:
      jest.fn<
        (input: LoginInput, metadata: RequestMetadata) => Promise<AuthSession>
      >(),
    refresh:
      jest.fn<
        (token: string, metadata: RequestMetadata) => Promise<AuthSession>
      >(),
    logout: jest.fn<(token: string) => Promise<void>>(),
    getUser: jest.fn<(userId: string) => Promise<AuthSession['user']>>(),
  };
  let authController: AuthController;
  const session: AuthSession = {
    user: {
      id: 'user-id',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      role: 'customer',
    },
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    authController = new AuthController(authService as unknown as AuthService);
  });

  it('sets the secure refresh cookie for registration', async () => {
    const input = {
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      displayName: 'Ada Lovelace',
      role: 'customer' as const,
    };
    const cookie = jest.fn();
    const request = createRequest();
    const response = { cookie } as unknown as Response;
    authService.register.mockResolvedValue(session);

    await expect(
      authController.register(input, request, response),
    ).resolves.toEqual({
      user: session.user,
      accessToken: session.accessToken,
    });
    expect(cookie.mock.calls[0]).toEqual([
      'refresh_token',
      session.refreshToken,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/api/auth',
      }),
    ]);
    expect(authService.register.mock.calls[0]).toEqual([
      input,
      { userAgent: 'test-agent', ip: '127.0.0.1' },
    ]);
  });

  it('returns the refresh token in the body only when explicitly requested', async () => {
    const input = {
      email: 'ada@example.com',
      password: 'correct-horse-battery',
    };
    const cookie = jest.fn();
    const request = createRequest({ 'x-refresh-token-in-body': 'true' });
    const response = { cookie } as unknown as Response;
    authService.login.mockResolvedValue(session);

    await expect(
      authController.login(input, request, response),
    ).resolves.toEqual(session);
    expect(cookie.mock.calls).toHaveLength(0);
  });

  it('requires the CSRF header and rotates a browser cookie token', async () => {
    const cookie = jest.fn();
    const request = createRequest(
      { 'x-requested-with': 'XMLHttpRequest' },
      { refresh_token: 'old-refresh-token' },
    );
    const response = { cookie } as unknown as Response;
    authService.refresh.mockResolvedValue(session);

    await expect(
      authController.refresh({}, request, response),
    ).resolves.toEqual({
      user: session.user,
      accessToken: session.accessToken,
    });
    expect(authService.refresh.mock.calls[0]).toEqual([
      'old-refresh-token',
      { userAgent: 'test-agent', ip: '127.0.0.1' },
    ]);
    expect(cookie.mock.calls).toHaveLength(1);
  });

  it('accepts refresh tokens in the body only with explicit opt-in', async () => {
    const cookie = jest.fn();
    const request = createRequest({
      'x-refresh-token-in-body': 'true',
      'x-requested-with': 'XMLHttpRequest',
    });
    authService.refresh.mockResolvedValue(session);

    await expect(
      authController.refresh({ refreshToken: 'body-refresh-token' }, request, {
        cookie,
      } as unknown as Response),
    ).resolves.toEqual(session);
    expect(authService.refresh.mock.calls[0]?.[0]).toBe('body-refresh-token');
    expect(cookie.mock.calls).toHaveLength(0);
  });

  it('rejects refresh without the CSRF header', async () => {
    const request = createRequest({}, { refresh_token: 'old-refresh-token' });
    await expect(
      authController.refresh({}, request, {
        cookie: jest.fn(),
      } as unknown as Response),
    ).rejects.toMatchObject({ code: 'CSRF_REQUIRED', status: 403 });
    expect(authService.refresh.mock.calls).toHaveLength(0);
  });

  it('revokes the cookie token on logout and clears the cookie', async () => {
    const request = createRequest(
      { 'x-requested-with': 'XMLHttpRequest' },
      {
        refresh_token: 'logout-refresh-token',
      },
    );
    const clearCookie = jest.fn();
    authService.logout.mockResolvedValue(undefined);

    await authController.logout({}, request, {
      clearCookie,
    } as unknown as Response);

    expect(authService.logout.mock.calls[0]).toEqual(['logout-refresh-token']);
    expect(clearCookie.mock.calls[0]).toEqual([
      'refresh_token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        path: '/api/auth',
      }),
    ]);
  });

  it('clears the cookie when logging out without a refresh token', async () => {
    const clearCookie = jest.fn();
    const request = createRequest({ 'x-requested-with': 'XMLHttpRequest' });

    await authController.logout({}, request, {
      clearCookie,
    } as unknown as Response);

    expect(authService.logout.mock.calls).toHaveLength(0);
    expect(clearCookie.mock.calls).toHaveLength(1);
  });

  it('loads the current user by the authenticated subject', async () => {
    authService.getUser.mockResolvedValue(session.user);

    await expect(
      authController.me({ sub: 'user-id', role: 'customer' }),
    ).resolves.toEqual(session.user);
    expect(authService.getUser.mock.calls[0]).toEqual(['user-id']);
  });
});

function createRequest(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
): Request {
  return {
    headers,
    cookies,
    ip: '127.0.0.1',
    get: (name: string) =>
      name.toLowerCase() === 'user-agent'
        ? 'test-agent'
        : headers[name.toLowerCase()],
  } as unknown as Request;
}
