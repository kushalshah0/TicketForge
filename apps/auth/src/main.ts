import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AuthModule } from './auth.module';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'auth';
  const app = await NestFactory.create(AuthModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
