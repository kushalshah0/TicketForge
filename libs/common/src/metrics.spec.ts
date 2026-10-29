import { lastValueFrom, of, throwError } from 'rxjs';
import { jest } from '@jest/globals';
import fs from 'node:fs';
import type {
  CallHandler,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CommonModule } from './common.module';
import { DomainError } from './errors';
import {
  MetricsController,
  MetricsInterceptor,
  MetricsService,
} from './metrics';

class MetricsTestController {}
Reflect.defineMetadata(PATH_METADATA, 'api', MetricsTestController);
const metricsTestHandler = (): void => undefined;
Reflect.defineMetadata(PATH_METADATA, 'bookings/:id', metricsTestHandler);

describe('MetricsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exports actual cgroup memory usage and limits when available', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const metrics = new MetricsService();
    const read = jest
      .spyOn(fs.promises, 'readFile')
      .mockImplementation((path) => {
        if (path === '/sys/fs/cgroup/memory.current')
          return Promise.resolve('251658240\n');
        if (path === '/sys/fs/cgroup/memory.max')
          return Promise.resolve('268435456\n');
        return Promise.reject(new Error('Unexpected cgroup path'));
      });

    const output = await metrics.registry.metrics();

    expect(read).toHaveBeenCalled();
    expect(output).toContain('container_memory_usage_bytes');
    expect(output).toContain('251658240');
    expect(output).toContain('container_memory_limit_bytes');
    expect(output).toContain('268435456');
  });

  it('does not silently report successful memory collection for invalid input', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const metrics = new MetricsService();
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue('invalid');

    await expect(metrics.registry.metrics()).rejects.toThrow(
      'Invalid cgroup memory value',
    );
  });

  it('serves the metrics endpoint directly from the service', async () => {
    const module = await Test.createTestingModule({
      imports: [CommonModule],
    }).compile();
    const app: INestApplication<App> = module.createNestApplication();
    try {
      await app.init();
      const response = await request(app.getHttpServer())
        .get('/metrics')
        .expect(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# HELP http_request_duration_seconds');
    } finally {
      await app.close();
    }
  });

  it('exposes process and application metrics in Prometheus text format', async () => {
    const metrics = new MetricsService();
    metrics.bookingHolds.inc({ result: 'success' });

    const output = await new MetricsController(metrics).getMetrics();

    expect(output).toContain('# HELP process_cpu_user_seconds_total');
    expect(output).toContain('# HELP booking_holds_total');
    expect(output).toContain('booking_holds_total{result="success"');
  });

  it('records HTTP duration with a route template and status class', async () => {
    const metrics = new MetricsService();
    const interceptor = new MetricsInterceptor(metrics);
    const request = {
      baseUrl: '/api',
      method: 'GET',
    } as Request;
    const response = { statusCode: 404 } as Response;
    const context = {
      getClass: () => MetricsTestController,
      getHandler: () => metricsTestHandler,
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
        getNext: () => undefined,
      }),
      switchToRpc: () => ({
        getData: () => undefined,
        getContext: () => undefined,
      }),
      switchToWs: () => ({
        getClient: () => undefined,
        getData: () => undefined,
        getPattern: () => 'pattern',
      }),
      getType: () => 'http',
    } as ExecutionContext;
    const handler = { handle: () => of({ ok: false }) } as CallHandler;

    await lastValueFrom(interceptor.intercept(context, handler));
    const output = await metrics.registry.metrics();

    expect(output).toContain('route="/api/bookings/:id"');
    expect(output).toContain('method="GET"');
    expect(output).toContain('status_class="4xx"');
  });

  it('records the exception status before the HTTP exception filter runs', async () => {
    const metrics = new MetricsService();
    const interceptor = new MetricsInterceptor(metrics);
    const request = { method: 'POST' } as Request;
    const response = { statusCode: 200 } as Response;
    const context = {
      getClass: () => MetricsTestController,
      getHandler: () => metricsTestHandler,
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
        getNext: () => undefined,
      }),
      switchToRpc: () => ({
        getData: () => undefined,
        getContext: () => undefined,
      }),
      switchToWs: () => ({
        getClient: () => undefined,
        getData: () => undefined,
        getPattern: () => 'pattern',
      }),
      getType: () => 'http',
    } as ExecutionContext;
    const error = new DomainError('Invalid input', 'VALIDATION_FAILED', 422);
    const handler = {
      handle: () => throwError(() => error),
    } as CallHandler;

    await expect(
      lastValueFrom(interceptor.intercept(context, handler)),
    ).rejects.toBe(error);
    const output = await metrics.registry.metrics();

    expect(output).toContain('status_class="4xx"');
  });
});
