import { json, urlencoded } from 'express';
import helmet from 'helmet';
import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

export function configureGatewayHttp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: number) => unknown;
  };
  expressApp.set('trust proxy', 1);
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Requested-With',
      'X-Request-Id',
    ],
  });
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
}
