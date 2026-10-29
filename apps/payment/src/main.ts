import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { PaymentModule } from './payment.module';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'payment';
  const app = await NestFactory.create(PaymentModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3004);
}
bootstrap();
