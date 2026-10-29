import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import { getCorrelationId } from './correlation';

export const REDACTED_VALUE = '[REDACTED]';

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const sensitiveTextPattern =
  /\b(password|passphrase|authorization|access[_-]?token|refresh[_-]?token|qr[_-]?token|token|cookie)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+|[^\s,;]+)/gi;

export const pinoHttpOptions: Options = {
  genReqId: (request) => {
    const header = request.headers['x-request-id'];
    return typeof header === 'string' &&
      header.length > 0 &&
      header.length <= 128
      ? header
      : randomUUID();
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'accessToken',
      'refreshToken',
      'qrToken',
    ],
    censor: REDACTED_VALUE,
  },
  serializers: {
    req: (request: { id: string; method: string; url: string }) => ({
      id: request.id,
      method: request.method,
      url: request.url.split('?')[0],
    }),
    err: (error: Error) => serializeError(error),
  },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map(redactLogValue) as typeof args);
    },
  },
  formatters: {
    log: (fields) => ({
      ...redactSensitiveFields(fields),
      service: process.env.SERVICE_NAME ?? 'ticketforge',
    }),
  },
  customProps: (request) => ({
    requestId: getCorrelationId() ?? request.id,
    ...('user' in request &&
    request.user &&
    typeof request.user === 'object' &&
    'sub' in request.user &&
    typeof request.user.sub === 'string'
      ? { userId: request.user.sub }
      : {}),
  }),
};

export const pinoLoggerModule = LoggerModule.forRoot({
  pinoHttp: pinoHttpOptions,
});

export function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return REDACTED_VALUE;
  return `${email[0]}***${email.slice(separator)}`;
}

export function redactSensitiveFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (/password|authorization|token|cookie/i.test(key))
        return [key, REDACTED_VALUE];
      if (key.toLowerCase() === 'email' && typeof value === 'string') {
        return [key, maskEmail(value)];
      }
      return [key, redactLogValue(value)];
    }),
  );
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactLogText(value);
  }
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return redactSensitiveFields(value as Record<string, unknown>);
  }
  return value;
}

function serializeError(
  error: Error,
  seen = new WeakSet<Error>(),
): Record<string, unknown> {
  if (seen.has(error)) return { type: error.name, message: REDACTED_VALUE };
  seen.add(error);
  return redactSensitiveFields({
    ...Object.fromEntries(Object.entries(error)),
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : { cause: redactLogValueWithSeen(error.cause, seen) }),
    ...(error instanceof AggregateError
      ? {
          errors: Array.from(error.errors as unknown[]).map((item) =>
            redactLogValueWithSeen(item, seen),
          ),
        }
      : {}),
  });
}

function redactLogValueWithSeen(value: unknown, seen: WeakSet<Error>): unknown {
  if (value instanceof Error) return serializeError(value, seen);
  if (Array.isArray(value))
    return value.map((item) => redactLogValueWithSeen(item, seen));
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|authorization|token|cookie/i.test(key)
          ? REDACTED_VALUE
          : key.toLowerCase() === 'email' && typeof item === 'string'
            ? maskEmail(item)
            : redactLogValueWithSeen(item, seen),
      ]),
    );
  }
  return redactLogValue(value);
}

function redactLogText(text: string): string {
  return text
    .replace(emailPattern, (email) => maskEmail(email))
    .replace(
      sensitiveTextPattern,
      (_match, field: string) => `${field}=${REDACTED_VALUE}`,
    );
}
