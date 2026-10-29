import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  SignJWT,
} from 'jose';
import { makeEnvelope, type EventType } from '@tf/contracts';

export interface StartedTestDependencies {
  postgres: StartedPostgreSqlContainer;
  rabbitmq: StartedRabbitMQContainer;
  stop(): Promise<void>;
}

export async function startTestDependencies(): Promise<StartedTestDependencies> {
  const [{ PostgreSqlContainer }, { RabbitMQContainer }] = await Promise.all([
    import('@testcontainers/postgresql'),
    import('@testcontainers/rabbitmq'),
  ]);
  const postgres = await new PostgreSqlContainer('postgres:16.4')
    .withDatabase('ticketforge_test')
    .withUsername('test_user')
    .withPassword('test_password')
    .start();

  try {
    const rabbitmq = await new RabbitMQContainer(
      'rabbitmq:3.13-management',
    ).start();
    return {
      postgres,
      rabbitmq,
      stop: async () => {
        await Promise.all([postgres.stop(), rabbitmq.stop()]);
      },
    };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}

export interface TestDatabase {
  name: string;
  connectionString: string;
  drop(): Promise<void>;
}

export async function createPerTestDatabase(
  adminPool: Pool,
): Promise<TestDatabase> {
  const name = `tf_test_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE DATABASE "${name}"`);
  const databaseUrl = new URL(adminPool.options.connectionString ?? '');
  databaseUrl.pathname = `/${name}`;

  return {
    name,
    connectionString: databaseUrl.toString(),
    drop: async () => {
      await adminPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await adminPool.query(`DROP DATABASE "${name}"`);
    },
  };
}

export async function generateTestJwtKeyPair(): Promise<{
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  return {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
    keyId: 'ticketforge-test-key',
  };
}

export async function signTestToken(options: {
  privateKeyPem: string;
  keyId: string;
  subject: string;
  role: 'customer' | 'organizer' | 'admin';
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const key = await importPKCS8(options.privateKeyPem, 'RS256');
  return new SignJWT({ role: options.role })
    .setProtectedHeader({ alg: 'RS256', kid: options.keyId })
    .setSubject(options.subject)
    .setIssuer(options.issuer ?? 'ticketforge-test')
    .setAudience(options.audience ?? 'ticketforge-api')
    .setIssuedAt()
    .setExpirationTime(`${options.expiresInSeconds ?? 60}s`)
    .sign(key);
}

export function makeTestEvent<TType extends EventType>(
  type: TType,
  data: Parameters<typeof makeEnvelope<TType>>[1],
) {
  return makeEnvelope(type, data, { correlationId: randomUUID() });
}

export async function waitFor<T>(
  condition: () => Promise<T | false | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result !== false && result !== null && result !== undefined)
        return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Condition was not met before timeout', { cause: lastError });
}
