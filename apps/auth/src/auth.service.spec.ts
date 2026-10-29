import argon2 from 'argon2';
import { jest } from '@jest/globals';
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importSPKI,
  jwtVerify,
} from 'jose';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AuthService, createAuthPool } from './auth.service';

describe('AuthService', () => {
  type QueryResult = { rows: Record<string, unknown>[] };
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<QueryResult>>();
  const poolQuery = jest.fn<(...args: unknown[]) => Promise<QueryResult>>();
  const client = {
    query: clientQuery,
    release: jest.fn<() => void>(),
  };
  const poolConnect = jest.fn<() => Promise<typeof client>>();
  const pool = {
    connect: poolConnect,
    query: poolQuery,
    end: jest.fn<() => Promise<void>>(),
  } as unknown as Pool;
  let service: AuthService;
  let verificationKey: Awaited<ReturnType<typeof importSPKI>>;
  let keyDirectory: string;
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    keyDirectory = await mkdtemp(join(tmpdir(), 'ticketforge-auth-'));
    await writeFile(
      join(keyDirectory, 'private.pem'),
      await exportPKCS8(keys.privateKey),
    );
    verificationKey = await importSPKI(
      await exportSPKI(keys.publicKey),
      'RS256',
    );

    for (const [name, value] of Object.entries({
      JWT_PRIVATE_KEY_PATH: join(keyDirectory, 'private.pem'),
      JWT_KEY_ID: 'auth-test-key',
      JWT_ISSUER: 'ticketforge-test',
      JWT_AUDIENCE: 'ticketforge-api',
    })) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(async () => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(keyDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    poolConnect.mockResolvedValue(client);
    service = new AuthService(pool);
  });

  it('stores an Argon2id hash and registration event in one transaction', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            email: 'ada@example.com',
            role: 'customer',
            display_name: 'Ada Lovelace',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const session = await service.register({
      email: ' Ada@Example.com ',
      password: 'correct-horse-battery',
      displayName: 'Ada Lovelace',
      role: 'customer',
    });

    const insertUserValues = clientQuery.mock.calls[1]?.[1] as [
      string,
      string,
      string,
      string,
    ];
    const passwordHash = insertUserValues[1];
    const refreshValues = clientQuery.mock.calls[2]?.[1] as [
      string,
      string,
      string,
      Date,
      string | undefined,
      string | undefined,
    ];
    const outboxValues = clientQuery.mock.calls[3]?.[1] as [
      string,
      string,
      string,
      string,
    ];
    const event = JSON.parse(outboxValues[2]) as Record<string, unknown>;
    const { payload, protectedHeader } = await jwtVerify(
      session.accessToken,
      verificationKey,
      {
        issuer: 'ticketforge-test',
        audience: 'ticketforge-api',
      },
    );

    expect(session.user).toEqual({
      id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      role: 'customer',
    });
    expect(insertUserValues[0]).toBe('ada@example.com');
    expect(await argon2.verify(passwordHash, 'correct-horse-battery')).toBe(
      true,
    );
    expect(passwordHash).toContain('$argon2id$v=19$m=19456,p=1,t=2$');
    expect(session.refreshToken).toHaveLength(43);
    expect(refreshValues[0]).toBe(session.user.id);
    expect(refreshValues[2]).toBe(
      createHash('sha256').update(session.refreshToken).digest('hex'),
    );
    expect(refreshValues[2]).not.toBe(session.refreshToken);
    expect(refreshValues[3].getTime() - Date.now()).toBeGreaterThan(
      13 * 24 * 60 * 60 * 1_000,
    );
    expect(protectedHeader).toMatchObject({
      alg: 'RS256',
      kid: 'auth-test-key',
    });
    expect(payload).toMatchObject({
      sub: session.user.id,
      role: 'customer',
      iss: 'ticketforge-test',
      aud: 'ticketforge-api',
    });
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
    expect(event).toMatchObject({
      type: 'user.registered',
      data: {
        userId: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
        role: session.user.role,
      },
    });
    expect(clientQuery.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQuery.mock.calls[4]?.[0]).toBe('COMMIT');
    expect(client.release.mock.calls).toHaveLength(1);
  });

  it('rejects passwords shorter than ten characters before opening a transaction', async () => {
    await expect(
      service.register({
        email: 'ada@example.com',
        password: 'short',
        displayName: 'Ada Lovelace',
        role: 'customer',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_TOO_WEAK', status: 422 });
    expect(poolConnect.mock.calls).toHaveLength(0);
  });

  it('returns the same invalid-credentials error for unknown and incorrect passwords', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
          email: 'ada@example.com',
          password_hash: await argon2.hash('correct password'),
          role: 'customer',
          display_name: 'Ada Lovelace',
        },
      ],
    });
    service = new AuthService(pool);

    const unknownUser = service.login({
      email: 'unknown@example.com',
      password: 'bad-password',
    });
    const wrongPassword = service.login({
      email: 'ada@example.com',
      password: 'bad-password',
    });

    await expect(unknownUser).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
    await expect(wrongPassword).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
    expect(poolQuery.mock.calls).toHaveLength(2);
  });

  it('stores a hashed refresh token after a successful login', async () => {
    const passwordHash = await argon2.hash('correct password');
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            email: 'ada@example.com',
            password_hash: passwordHash,
            role: 'customer',
            display_name: 'Ada Lovelace',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const session = await service.login(
      { email: 'ada@example.com', password: 'correct password' },
      { userAgent: 'test-agent', ip: '127.0.0.1' },
    );
    const refreshValues = poolQuery.mock.calls[1]?.[1] as [
      string,
      string,
      string,
      Date,
      string,
      string,
    ];

    expect(refreshValues[0]).toBe(session.user.id);
    expect(refreshValues[2]).toBe(
      createHash('sha256').update(session.refreshToken).digest('hex'),
    );
    expect(refreshValues[4]).toBe('test-agent');
    expect(refreshValues[5]).toBe('127.0.0.1');
  });

  it('rotates a refresh token within its existing family', async () => {
    const oldToken = 'old-refresh-token';
    const familyId = '80d10948-c1d7-47a6-ae19-09b1d3b9a6bf';
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'refresh-row-id',
            user_id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            family_id: familyId,
            expires_at: new Date(Date.now() + 60_000),
            used_at: null,
            revoked_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            email: 'ada@example.com',
            role: 'customer',
            display_name: 'Ada Lovelace',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const session = await service.refresh(oldToken, {
      userAgent: 'rotating-agent',
      ip: '127.0.0.1',
    });
    const inserted = clientQuery.mock.calls[4]?.[1] as [
      string,
      string,
      string,
      Date,
      string,
      string,
    ];

    expect(clientQuery.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[3]?.[0]).toContain('used_at = now()');
    expect(inserted[1]).toBe(familyId);
    expect(inserted[2]).toBe(
      createHash('sha256').update(session.refreshToken).digest('hex'),
    );
    expect(inserted[2]).not.toBe(
      createHash('sha256').update(oldToken).digest('hex'),
    );
    expect(inserted[4]).toBe('rotating-agent');
    expect(clientQuery.mock.calls[5]?.[0]).toBe('COMMIT');
  });

  it('revokes the whole family when a refresh token is reused', async () => {
    const familyId = '80d10948-c1d7-47a6-ae19-09b1d3b9a6bf';
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'used-refresh-row',
            user_id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            family_id: familyId,
            expires_at: new Date(Date.now() + 60_000),
            used_at: new Date(),
            revoked_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.refresh('reused-refresh-token')).rejects.toMatchObject(
      {
        code: 'REFRESH_REUSED',
        status: 401,
      },
    );
    expect(clientQuery.mock.calls[2]?.[0]).toContain('WHERE family_id = $1');
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([familyId]);
    expect(clientQuery.mock.calls[3]?.[0]).toBe('COMMIT');
  });

  it('rejects expired refresh tokens', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'expired-refresh-row',
            user_id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
            family_id: '80d10948-c1d7-47a6-ae19-09b1d3b9a6bf',
            expires_at: new Date(Date.now() - 60_000),
            used_at: null,
            revoked_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.refresh('expired-refresh-token'),
    ).rejects.toMatchObject({
      code: 'REFRESH_EXPIRED',
      status: 401,
    });
    expect(clientQuery.mock.calls[2]?.[0]).toBe('ROLLBACK');
  });

  it('rejects unknown refresh tokens and rolls back', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.refresh('unknown-refresh-token'),
    ).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      status: 401,
    });
    expect(clientQuery.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[2]?.[0]).toBe('ROLLBACK');
  });

  it('rejects refresh tokens for users that no longer exist', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'refresh-row-id',
            user_id: 'deleted-user-id',
            family_id: '80d10948-c1d7-47a6-ae19-09b1d3b9a6bf',
            expires_at: new Date(Date.now() + 60_000),
            used_at: null,
            revoked_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.refresh('orphaned-refresh-token'),
    ).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      status: 401,
    });
    expect(clientQuery.mock.calls[3]?.[0]).toBe('ROLLBACK');
  });

  it('fails closed when JWT signing configuration is missing', async () => {
    const passwordHash = await argon2.hash('correct password');
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
          email: 'ada@example.com',
          password_hash: passwordHash,
          role: 'customer',
          display_name: 'Ada Lovelace',
        },
      ],
    });
    const keyId = process.env.JWT_KEY_ID;
    delete process.env.JWT_KEY_ID;

    try {
      await expect(
        service.login({
          email: 'ada@example.com',
          password: 'correct password',
        }),
      ).rejects.toMatchObject({ code: 'AUTH_CONFIG_ERROR', status: 500 });
      expect(poolQuery.mock.calls).toHaveLength(1);
    } finally {
      if (keyId) process.env.JWT_KEY_ID = keyId;
    }
  });

  it('requires an auth database URL and creates a pool when configured', async () => {
    const databaseUrl = process.env.AUTH_DATABASE_URL;
    delete process.env.AUTH_DATABASE_URL;
    expect(() => createAuthPool()).toThrow('AUTH_DATABASE_URL is required');

    process.env.AUTH_DATABASE_URL =
      'postgresql://user:pass@127.0.0.1:5433/auth';
    const authPool = createAuthPool();
    expect(authPool.options.connectionString).toBe(
      process.env.AUTH_DATABASE_URL,
    );
    await authPool.end();

    if (databaseUrl) process.env.AUTH_DATABASE_URL = databaseUrl;
    else delete process.env.AUTH_DATABASE_URL;
  });

  it('revokes a token family on logout', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });

    await service.logout('logout-refresh-token');

    expect(poolQuery.mock.calls[0]?.[0]).toContain('family_id');
    expect(poolQuery.mock.calls[0]?.[1]).toEqual([
      createHash('sha256').update('logout-refresh-token').digest('hex'),
    ]);
  });

  it('returns the public user for a token subject', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
          email: 'ada@example.com',
          role: 'customer',
          display_name: 'Ada Lovelace',
        },
      ],
    });

    await expect(
      service.getUser('7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91'),
    ).resolves.toEqual({
      id: '7b6e1737-4fc4-4288-aa9a-5b8d2aef2a91',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      role: 'customer',
    });
  });

  it('rolls back registration when the email is already taken', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'users_email_unique',
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.register({
        email: 'ada@example.com',
        password: 'correct-horse-battery',
        displayName: 'Ada Lovelace',
        role: 'customer',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
    expect(clientQuery.mock.calls[2]?.[0]).toBe('ROLLBACK');
    expect(client.release.mock.calls).toHaveLength(1);
  });
});
