import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { DomainError, ProblemDetailsFilter } from './errors';
import {
  CorrelationIdMiddleware,
  getCorrelationId,
  runWithCorrelationId,
} from './correlation';
import { jest } from '@jest/globals';

describe('ProblemDetailsFilter', () => {
  it('serializes domain errors as problem details with the active request id', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/events' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    runWithCorrelationId('request-123', () => {
      new ProblemDetailsFilter().catch(
        new DomainError(
          'Event is unavailable',
          'EVENT_UNAVAILABLE',
          HttpStatus.CONFLICT,
        ),
        host,
      );
    });

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    expect(response.json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Conflict',
      status: HttpStatus.CONFLICT,
      detail: 'Event is unavailable',
      instance: '/events',
      code: 'EVENT_UNAVAILABLE',
      requestId: 'request-123',
    });
  });

  it('includes explicit domain error details in problem responses', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/checkin' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new ProblemDetailsFilter().catch(
      new DomainError(
        'Ticket was already used',
        'TICKET_ALREADY_USED',
        HttpStatus.CONFLICT,
        {
          usedAt: '2026-10-26T12:00:00.000Z',
        },
      ),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TICKET_ALREADY_USED',
        usedAt: '2026-10-26T12:00:00.000Z',
      }),
    );
  });

  it('does not expose unexpected server errors', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/private' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new ProblemDetailsFilter().catch(
      new Error('database password leaked'),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'Internal server error',
        code: 'INTERNAL_ERROR',
      }),
    );
  });

  it('returns a sanitized 413 problem for oversized request bodies', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/api/auth/login' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    const error = Object.assign(new Error('body contents are not returned'), {
      type: 'entity.too.large',
    });

    new ProblemDetailsFilter().catch(error, host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        detail: 'Request body exceeds the 100 KB limit',
        code: 'PAYLOAD_TOO_LARGE',
      }),
    );
  });
});

describe('CorrelationIdMiddleware', () => {
  it('preserves a request id and exposes it through async context', () => {
    const setHeader = jest.fn();
    const next = jest.fn(() => expect(getCorrelationId()).toBe('caller-id'));

    new CorrelationIdMiddleware().use(
      { headers: { 'x-request-id': 'caller-id' } } as never,
      { setHeader } as never,
      next,
    );

    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'caller-id');
    expect(next).toHaveBeenCalled();
  });
});
