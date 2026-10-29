import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { CatalogModule } from './catalog.module';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'catalog';
  const app = await NestFactory.create(CatalogModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}
bootstrap();
