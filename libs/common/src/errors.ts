import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';
import { getCorrelationId } from './correlation';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = HttpStatus.BAD_REQUEST,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface ProblemDetails {
  [key: string]: unknown;
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId?: string;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = getStatus(exception);
    const code = getCode(exception, status);
    const detail = getDetail(exception, status);
    const requestId = getCorrelationId();

    const problem: ProblemDetails = {
      ...(exception instanceof DomainError ? exception.details : {}),
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail,
      instance: request.url,
      code,
      ...(requestId ? { requestId } : {}),
    };

    response.status(status).type('application/problem+json').json(problem);
  }
}

function getStatus(exception: unknown): number {
  if (exception instanceof DomainError) return exception.status;
  if (exception instanceof HttpException) return exception.getStatus();
  if (getBodyParserErrorType(exception) === 'entity.too.large')
    return HttpStatus.PAYLOAD_TOO_LARGE;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function getCode(exception: unknown, status: number): string {
  if (exception instanceof DomainError) return exception.code;
  if (getBodyParserErrorType(exception) === 'entity.too.large')
    return 'PAYLOAD_TOO_LARGE';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
}

function getDetail(exception: unknown, status: number): string {
  if (exception instanceof DomainError) return exception.message;
  if (exception instanceof HttpException) return exception.message;
  if (getBodyParserErrorType(exception) === 'entity.too.large') {
    return 'Request body exceeds the 100 KB limit';
  }
  return status >= 500 ? 'Internal server error' : 'Request failed';
}

function getBodyParserErrorType(exception: unknown): string | undefined {
  if (!(exception instanceof Error)) return undefined;
  const type: unknown = Reflect.get(exception, 'type');
  return typeof type === 'string' ? type : undefined;
}
