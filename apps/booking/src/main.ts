import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { BookingModule } from './booking.module';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'booking';
  const app = await NestFactory.create(BookingModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3003);
}
bootstrap();
