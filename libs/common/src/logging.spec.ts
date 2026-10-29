import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import pinoHttp from 'pino-http';
import request from 'supertest';
import {
  REDACTED_VALUE,
  pinoHttpOptions,
  redactSensitiveFields,
} from './logging';
import { CorrelationIdMiddleware, getCorrelationId } from './correlation';
import type { Request, Response } from 'express';

describe('logging redaction', () => {
  it('redacts cookie headers that can contain refresh tokens', () => {
    expect(
      redactSensitiveFields({ 'set-cookie': 'refresh_token=secret' }),
    ).toEqual({
      'set-cookie': REDACTED_VALUE,
    });
  });

  it.each([undefined, 'client-request-id', '', 'x'.repeat(129)])(
    'scrubs actual JSON logs and preserves request correlation for header %s',
    async (requestId) => {
      const output: string[] = [];
      const destination = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output.push(chunk.toString());
          callback();
        },
      });
      const logger = pinoHttp(pinoHttpOptions, destination);
      const correlation = new CorrelationIdMiddleware();
      let handlerRequestId: string | undefined;
      const server = createServer((req, res) => {
        logger(req, res);
        correlation.use(req as Request, res as Response, () => {
          handlerRequestId = getCorrelationId();
          Object.assign(req, { user: { sub: 'test-user-id' } });
          req.log.info(
            {
              service: 'untrusted-service',
              password: 'secret-password',
              accessToken: 'secret-access',
              refreshToken: 'secret-refresh',
              qrToken: 'secret-qr',
              email: 'private-person@example.test',
              nested: {
                password: 'nested-password',
                email: 'nested-person@example.test',
              },
              items: [
                { token: 'array-token', email: 'array-person@example.test' },
              ],
            },
            'test log',
          );
          req.log.error(
            {
              err: new Error(
                'failure for private-error@example.test password=error-password accessToken=error-access-token',
                {
                  cause: new Error(
                    'caused by private-cause@example.test refreshToken=cause-refresh-token',
                  ),
                },
              ),
            },
            'request failed',
          );
          req.log.warn(
            'Background failure for private-message@example.test authorization=Bearer message-secret-token',
          );
          res.setHeader('set-cookie', 'refresh_token=secret-cookie');
          res.end('ok');
        });
      });
      const pending = request(server)
        .get('/events?q=private-person@example.test&token=query-secret')
        .set('Authorization', 'Bearer secret-bearer')
        .set('Cookie', 'refresh_token=secret-cookie');
      if (requestId !== undefined) pending.set('x-request-id', requestId);
      const response = await pending;
      const text = output.join('');
      for (const sensitive of [
        'secret-password',
        'secret-access',
        'secret-refresh',
        'secret-qr',
        'secret-bearer',
        'secret-cookie',
        'private-person@example.test',
        'nested-password',
        'nested-person@example.test',
        'array-token',
        'array-person@example.test',
        'query-secret',
        'private-error@example.test',
        'error-password',
        'error-access-token',
        'private-cause@example.test',
        'cause-refresh-token',
        'private-message@example.test',
        'message-secret-token',
      ])
        expect(text).not.toContain(sensitive);
      const records = output
        .flatMap((line) => line.trim().split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.length).toBeGreaterThanOrEqual(2);
      for (const record of records) {
        expect(record).toMatchObject({
          service: 'ticketforge',
          requestId: response.headers['x-request-id'],
        });
        expect(record.level).toEqual(expect.any(Number));
        expect(record.time).toEqual(expect.any(Number));
      }
      expect(handlerRequestId).toBe(response.headers['x-request-id']);
      expect(records.at(-1)?.userId).toBe('test-user-id');
      if (requestId === 'client-request-id')
        expect(handlerRequestId).toBe(requestId);
      else expect(handlerRequestId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});
