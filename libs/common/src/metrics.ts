import {
  Controller,
  Get,
  Header,
  HttpException,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import fs from 'node:fs';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DomainError } from './errors';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import type { Response } from 'express';
import { finalize, tap, type Observable } from 'rxjs';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestDuration: Histogram<string>;
  readonly bookingHolds: Counter<string>;
  readonly bookingStateTransitions: Counter<string>;
  readonly paymentWebhooks: Counter<string>;
  readonly cacheRequests: Counter<string>;

  constructor() {
    this.registry.setDefaultLabels({
      service: process.env.SERVICE_NAME ?? 'unknown',
    });
    collectDefaultMetrics({ register: this.registry });
    for (const [name, file] of [
      ['container_memory_usage_bytes', '/sys/fs/cgroup/memory.current'],
      ['container_memory_limit_bytes', '/sys/fs/cgroup/memory.max'],
    ]) {
      if (!fs.existsSync(file)) {
        new Logger(MetricsService.name).debug(
          `Cgroup v2 metric unavailable: ${file}`,
        );
        continue;
      }
      new Gauge({
        name,
        help: `Container cgroup v2 memory from ${file}`,
        registers: [this.registry],
        async collect() {
          const text = (await fs.promises.readFile(file, 'utf8')).trim();
          const value = text === 'max' ? Infinity : Number(text);
          if (!text || Number.isNaN(value) || value < 0) {
            throw new Error(`Invalid cgroup memory value in ${file}`);
          }
          this.set(value);
        },
      });
    }
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['route', 'method', 'status_class'],
      registers: [this.registry],
    });
    this.bookingHolds = new Counter({
      name: 'booking_holds_total',
      help: 'Booking hold requests by result',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.bookingStateTransitions = new Counter({
      name: 'booking_state_transitions_total',
      help: 'Booking state transitions by source and destination state',
      labelNames: ['from', 'to'],
      registers: [this.registry],
    });
    this.paymentWebhooks = new Counter({
      name: 'payment_webhooks_total',
      help: 'Payment webhook requests by result',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.cacheRequests = new Counter({
      name: 'cache_requests_total',
      help: 'Catalog cache reads by result',
      labelNames: ['result'],
      registers: [this.registry],
    });
  }
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const response = http.getResponse<Response>();
    const controllerPath = readRoutePath(context.getClass());
    const handlerPath = readRoutePath(context.getHandler());
    const route =
      `/${[controllerPath, handlerPath].filter(Boolean).join('/')}`.replace(
        /\/+/g,
        '/',
      ) || 'unmatched';
    const method = http.getRequest<{ method: string }>().method.toUpperCase();
    const startedAt = process.hrtime.bigint();
    let observed = false;
    const observe = (statusCode: number) => {
      if (observed) return;
      observed = true;
      const statusClass = `${Math.floor(statusCode / 100)}xx`;
      const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.httpRequestDuration.observe(
        { route, method, status_class: statusClass },
        duration,
      );
    };

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          const statusCode =
            error instanceof DomainError
              ? error.status
              : error instanceof HttpException
                ? error.getStatus()
                : 500;
          observe(statusCode);
        },
      }),
      finalize(() => {
        observe(response.statusCode);
      }),
    );
  }
}

function readRoutePath(target: object): string | undefined {
  const path: unknown = Reflect.getMetadata(PATH_METADATA, target);
  return typeof path === 'string' ? path : undefined;
}

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
