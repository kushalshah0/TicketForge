import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { NotificationModule } from './notification.module';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'notification';
  const app = await NestFactory.create(NotificationModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3005);
}
bootstrap();
