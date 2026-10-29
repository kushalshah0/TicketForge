import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface CorrelationContext {
  correlationId: string;
  traceparent?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function getTraceparent(): string | undefined {
  return correlationStorage.getStore()?.traceparent;
}

export function runWithCorrelationId<T>(
  correlationId: string,
  callback: () => T,
  traceparent?: string,
): T {
  return correlationStorage.run(
    { correlationId, ...(traceparent ? { traceparent } : {}) },
    callback,
  );
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestIdHeader = request.headers['x-request-id'];
    const correlationId =
      typeof requestIdHeader === 'string' &&
      requestIdHeader.length > 0 &&
      requestIdHeader.length <= 128
        ? requestIdHeader
        : typeof request.id === 'string'
          ? request.id
          : randomUUID();

    response.setHeader('x-request-id', correlationId);
    runWithCorrelationId(correlationId, next);
  }
}
