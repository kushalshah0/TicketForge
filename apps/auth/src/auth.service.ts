import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import argon2 from 'argon2';
import { importPKCS8, SignJWT } from 'jose';
import { makeEnvelope } from '@tf/contracts';
import {
  createPgPool,
  DomainError,
  getCorrelationId,
  getTraceparent,
} from '@tf/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';

export const AUTH_POOL = Symbol('AUTH_POOL');

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10),
  displayName: z.string().trim().min(1),
  role: z.enum(['customer', 'organizer']),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type RegisterInput = z.input<typeof registerSchema>;
export type LoginInput = z.input<typeof loginSchema>;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'customer' | 'organizer';
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface RequestMetadata {
  userAgent?: string;
  ip?: string;
}

interface UserRow {
  id: string;
  email: string;
  role: 'customer' | 'organizer';
  display_name: string;
}

interface LoginRow extends UserRow {
  password_hash: string;
}

interface RefreshRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async register(
    input: RegisterInput,
    metadata: RequestMetadata = {},
  ): Promise<AuthSession> {
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) {
      const weakPassword = parsed.error.issues.some(
        (issue) => issue.path[0] === 'password',
      );
      throw new DomainError(
        weakPassword
          ? 'Password must be at least 10 characters'
          : 'Invalid registration details',
        weakPassword ? 'PASSWORD_TOO_WEAK' : 'VALIDATION_FAILED',
        422,
      );
    }

    const { email, password, displayName, role } = parsed.data;
    const passwordHash = await argon2.hash(password, passwordOptions);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, role, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, display_name`,
        [email, passwordHash, role, displayName],
      );
      const user = result.rows[0];
      if (!user) throw new Error('User insert returned no row');

      const session = await this.createSession(
        user,
        (values) =>
          client.query(
            `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              values.userId,
              values.familyId,
              values.tokenHash,
              values.expiresAt,
              values.userAgent,
              values.ip,
            ],
          ),
        metadata,
      );
      const correlationId = getCorrelationId() ?? randomUUID();
      const event = makeEnvelope(
        'user.registered',
        {
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
        },
        { correlationId },
      );
      const traceparent = getTraceparent();
      const headers = {
        'x-correlation-id': correlationId,
        ...(traceparent ? { traceparent } : {}),
      };
      await client.query(
        `INSERT INTO outbox (message_id, type, payload, headers)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
        [event.id, event.type, JSON.stringify(event), JSON.stringify(headers)],
      );
      await client.query('COMMIT');

      return session;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isEmailConflict(error)) {
        throw new DomainError(
          'An account with this email already exists',
          'EMAIL_TAKEN',
          409,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async login(
    input: LoginInput,
    metadata: RequestMetadata = {},
  ): Promise<AuthSession> {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        'Invalid email or password',
        'INVALID_CREDENTIALS',
        401,
      );
    }

    const result = await this.pool.query<LoginRow>(
      `SELECT id, email, password_hash, role, display_name
       FROM users WHERE email = $1`,
      [parsed.data.email],
    );
    const user = result.rows[0];
    if (!user) {
      await argon2.hash(parsed.data.password, passwordOptions);
      throw new DomainError(
        'Invalid email or password',
        'INVALID_CREDENTIALS',
        401,
      );
    }

    if (!(await argon2.verify(user.password_hash, parsed.data.password))) {
      throw new DomainError(
        'Invalid email or password',
        'INVALID_CREDENTIALS',
        401,
      );
    }

    return this.createSession(
      user,
      (values) =>
        this.pool.query(
          `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            values.userId,
            values.familyId,
            values.tokenHash,
            values.expiresAt,
            values.userAgent,
            values.ip,
          ],
        ),
      metadata,
    );
  }

  async refresh(
    token: string,
    metadata: RequestMetadata = {},
  ): Promise<AuthSession> {
    if (!token) throw invalidRefreshToken();

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<RefreshRow>(
        `SELECT id, user_id, family_id, expires_at, used_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const current = result.rows[0];
      if (!current) throw invalidRefreshToken();

      if (current.used_at || current.revoked_at) {
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
           WHERE family_id = $1`,
          [current.family_id],
        );
        await client.query('COMMIT');
        throw new DomainError(
          'Refresh token reuse detected',
          'REFRESH_REUSED',
          401,
        );
      }

      if (current.expires_at.getTime() <= Date.now()) {
        throw new DomainError('Refresh token expired', 'REFRESH_EXPIRED', 401);
      }

      const userResult = await client.query<UserRow>(
        `SELECT id, email, role, display_name FROM users WHERE id = $1`,
        [current.user_id],
      );
      const user = userResult.rows[0];
      if (!user) throw invalidRefreshToken();

      await client.query(
        'UPDATE refresh_tokens SET used_at = now() WHERE id = $1',
        [current.id],
      );
      const session = await this.createSession(
        user,
        (values) =>
          client.query(
            `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              values.userId,
              values.familyId,
              values.tokenHash,
              values.expiresAt,
              values.userAgent,
              values.ip,
            ],
          ),
        metadata,
        current.family_id,
      );
      await client.query('COMMIT');
      return session;
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'REFRESH_REUSED')) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(token: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [tokenHash],
    );
  }

  async getUser(userId: string): Promise<AuthUser> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, role, display_name FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user)
      throw new DomainError('Invalid access token', 'INVALID_TOKEN', 401);
    return toAuthUser(user);
  }

  private async createSession(
    user: UserRow,
    persistRefreshToken: (values: {
      userId: string;
      familyId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string;
      ip?: string;
    }) => Promise<unknown>,
    metadata: RequestMetadata,
    familyId: string = randomUUID(),
  ): Promise<AuthSession> {
    const accessToken = await this.createAccessToken(user);
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000);
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await persistRefreshToken({
      userId: user.id,
      familyId,
      tokenHash,
      expiresAt,
      ...metadata,
    });

    return { user: toAuthUser(user), accessToken, refreshToken };
  }

  private async createAccessToken(user: UserRow): Promise<string> {
    const keyPath = process.env.JWT_PRIVATE_KEY_PATH;
    const keyId = process.env.JWT_KEY_ID;
    const issuer = process.env.JWT_ISSUER;
    const audience = process.env.JWT_AUDIENCE;
    if (!keyPath || !keyId || !issuer || !audience) {
      throw new DomainError(
        'Token issuing is not configured',
        'AUTH_CONFIG_ERROR',
        500,
      );
    }

    try {
      const privateKeyPem = await readFile(resolve(keyPath), 'utf8');
      const privateKey = await importPKCS8(privateKeyPem, 'RS256');
      return new SignJWT({ role: user.role })
        .setProtectedHeader({ alg: 'RS256', kid: keyId })
        .setSubject(user.id)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privateKey);
    } catch {
      throw new DomainError(
        'Token signing key is unavailable',
        'AUTH_CONFIG_ERROR',
        500,
      );
    }
  }
}

export function createAuthPool(): Pool {
  const connectionString = process.env.AUTH_DATABASE_URL;
  if (!connectionString) throw new Error('AUTH_DATABASE_URL is required');
  return createPgPool({ connectionString });
}

function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
  };
}

function isEmailConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'users_email_unique'
  );
}

function invalidRefreshToken(): DomainError {
  return new DomainError('Invalid refresh token', 'INVALID_REFRESH_TOKEN', 401);
}
