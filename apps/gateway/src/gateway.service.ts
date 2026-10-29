import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, getCorrelationId } from '@tf/common';

export type GatewayServiceName = 'auth' | 'catalog' | 'booking' | 'payment';
export type GatewayRole = 'customer' | 'organizer' | 'any';

export interface GatewayRoute {
  service: GatewayServiceName;
  role?: GatewayRole;
}

const serviceOrigins: Record<GatewayServiceName, string> = {
  auth: process.env.AUTH_SERVICE_URL ?? 'http://127.0.0.1:3001',
  catalog: process.env.CATALOG_SERVICE_URL ?? 'http://127.0.0.1:3002',
  booking: process.env.BOOKING_SERVICE_URL ?? 'http://127.0.0.1:3003',
  payment: process.env.PAYMENT_SERVICE_URL ?? 'http://127.0.0.1:3004',
};

const hiddenRoutes = ['/api/metrics', '/api/internal', '/api/payments/webhook'];

export function resolveGatewayRoute(
  method: string,
  pathname: string,
): GatewayRoute | undefined {
  const normalizedMethod = method.toUpperCase();
  if (
    hiddenRoutes.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    )
  ) {
    return undefined;
  }

  if (
    ['/api/auth/register', '/api/auth/login', '/api/auth/refresh'].includes(
      pathname,
    ) &&
    normalizedMethod === 'POST'
  ) {
    return { service: 'auth' };
  }
  if (pathname === '/api/auth/logout' && normalizedMethod === 'POST') {
    return { service: 'auth', role: 'any' };
  }
  if (pathname === '/api/auth/me' && normalizedMethod === 'GET') {
    return { service: 'auth', role: 'any' };
  }
  if (pathname === '/api/events' && normalizedMethod === 'GET')
    return { service: 'catalog' };
  if (
    /^\/api\/events\/[^/]+\/availability$/.test(pathname) &&
    normalizedMethod === 'GET'
  ) {
    return { service: 'booking' };
  }
  if (/^\/api\/events\/[^/]+$/.test(pathname) && normalizedMethod === 'GET') {
    return { service: 'catalog' };
  }
  if (pathname === '/api/organizer/events' && normalizedMethod === 'GET') {
    return { service: 'catalog', role: 'organizer' };
  }
  if (
    /^\/api\/events(?:\/[^/]+)?$/.test(pathname) &&
    ['POST', 'PATCH'].includes(normalizedMethod)
  ) {
    return { service: 'catalog', role: 'organizer' };
  }
  if (
    normalizedMethod === 'POST' &&
    /^\/api\/events\/[^/]+\/(publish|cancel)$/.test(pathname)
  ) {
    return { service: 'catalog', role: 'organizer' };
  }
  if (/^\/api\/(bookings|tickets)(?:\/.*)?$/.test(pathname)) {
    return { service: 'booking', role: 'customer' };
  }
  if (pathname === '/api/checkin' && normalizedMethod === 'POST') {
    return { service: 'booking', role: 'organizer' };
  }
  if (/^\/api\/payments(?:\/.*)?$/.test(pathname)) {
    return { service: 'payment', role: 'customer' };
  }

  return undefined;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  getHello(): string {
    return 'Hello World!';
  }

  async forward(request: Request, response: Response): Promise<void> {
    const incomingUrl = new URL(request.originalUrl, 'http://gateway.local');
    const route = resolveGatewayRoute(request.method, incomingUrl.pathname);
    if (!route) throw new DomainError('Route not found', 'NOT_FOUND', 404);

    const serviceOrigin = serviceOrigins[route.service];
    const target = new URL(
      incomingUrl.pathname.replace(/^\/api(?=\/|$)/, '') || '/',
      serviceOrigin,
    );
    target.search = incomingUrl.search;
    this.logger.debug(
      `${request.method} ${incomingUrl.pathname} -> ${route.service}`,
    );

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value &&
        !['connection', 'content-length', 'host', 'transfer-encoding'].includes(
          name,
        )
      ) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
    }
    const requestId = getCorrelationId();
    if (requestId) headers.set('x-request-id', requestId);

    const hasBody =
      !['GET', 'HEAD'].includes(request.method.toUpperCase()) &&
      request.body !== undefined;
    const body = hasBody
      ? Buffer.isBuffer(request.body)
        ? new Uint8Array(request.body)
        : JSON.stringify(request.body)
      : undefined;
    const method = request.method.toUpperCase();
    const signal = AbortSignal.timeout(5_000);
    const forwardOnce = async () => {
      const upstream = await fetch(target, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
      });
      const responseHeaders = [
        'cache-control',
        'content-type',
        'etag',
        'location',
        'retry-after',
        'set-cookie',
      ].flatMap((name) => {
        const value = upstream.headers.get(name);
        return value ? [[name, value] as const] : [];
      });
      return {
        status: upstream.status,
        headers: responseHeaders,
        body: Buffer.from(await upstream.arrayBuffer()),
      };
    };

    let result;
    try {
      result = await forwardOnce();
    } catch {
      if (method !== 'GET' || signal.aborted) {
        throw new DomainError(
          'Downstream service unavailable',
          'SERVICE_UNAVAILABLE',
          503,
        );
      }
      try {
        result = await forwardOnce();
      } catch {
        throw new DomainError(
          'Downstream service unavailable',
          'SERVICE_UNAVAILABLE',
          503,
        );
      }
    }

    for (const [name, value] of result.headers) {
      response.setHeader(name, value);
    }
    response.status(result.status).send(result.body);
  }
}
