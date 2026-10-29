import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { jest } from '@jest/globals';
import { Reflector } from '@nestjs/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from './errors';
import { JwtAuthGuard, RolesGuard } from './auth';

describe('JwtAuthGuard', () => {
  const keyId = 'test-key';
  const issuer = 'ticketforge-test';
  const audience = 'ticketforge-api';
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicKeyPem: string;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    publicKeyPem = await exportSPKI(keys.publicKey);
    process.env.JWT_KEY_ID = keyId;
    process.env.JWT_ISSUER = issuer;
    process.env.JWT_AUDIENCE = audience;
    process.env.JWT_PUBLIC_KEY = publicKeyPem;
  });

  afterAll(() => {
    delete process.env.JWT_KEY_ID;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_PUBLIC_KEY;
  });

  it('rejects requests without a bearer token', async () => {
    await expect(
      new JwtAuthGuard().canActivate(createContext({ headers: {} })),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    } satisfies Partial<DomainError>);
  });

  it('verifies a token and attaches its user claims', async () => {
    const token = await createToken();
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: { authorization: `Bearer ${token}` },
    };

    await expect(
      new JwtAuthGuard().canActivate(createContext(request)),
    ).resolves.toBe(true);
    expect(request.user).toEqual({ sub: 'user-1', role: 'customer' });
  });

  it('loads the public key from the configured mounted file path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ticketforge-jwt-'));
    const keyPath = join(directory, 'public.pem');
    const fileKeys = await generateKeyPair('RS256');
    const filePublicKey = await exportSPKI(fileKeys.publicKey);
    await writeFile(keyPath, filePublicKey);
    delete process.env.JWT_PUBLIC_KEY;
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;
    const fileToken = await new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setSubject('user-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(fileKeys.privateKey);
    const request: { headers: { authorization: string }; user?: unknown } = {
      headers: { authorization: `Bearer ${fileToken}` },
    };

    try {
      await expect(
        new JwtAuthGuard().canActivate(createContext(request)),
      ).resolves.toBe(true);
      expect(request.user).toEqual({ sub: 'user-1', role: 'customer' });
    } finally {
      process.env.JWT_PUBLIC_KEY = publicKeyPem;
      delete process.env.JWT_PUBLIC_KEY_PATH;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a token signed by a different key', async () => {
    const otherKey = await generateKeyPair('RS256');
    const token = await new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setSubject('user-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(otherKey.privateKey);

    await expect(
      new JwtAuthGuard().canActivate(
        createContext({ headers: { authorization: `Bearer ${token}` } }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      status: 401,
    } satisfies Partial<DomainError>);
  });

  it('returns TOKEN_EXPIRED for an expired token', async () => {
    const token = await createToken(Math.floor(Date.now() / 1000) - 1);
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(
      new JwtAuthGuard().canActivate(createContext(request)),
    ).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    } satisfies Partial<DomainError>);
  });

  async function createToken(
    expiration = Math.floor(Date.now() / 1000) + 60,
  ): Promise<string> {
    return new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setSubject('user-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(privateKey);
  }
});

describe('RolesGuard', () => {
  it('rejects a user whose role does not satisfy route metadata', () => {
    const reflector = {
      getAllAndOverride: jest.fn(() => ['organizer']),
    } as unknown as Reflector;
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: 'user-1', role: 'customer' } }),
      }),
    };

    expect(new RolesGuard(reflector).canActivate(context as never)).toBe(false);
  });
});

function createContext(request: {
  headers: Record<string, string>;
  user?: unknown;
}) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}
