import { NestFactory } from '@nestjs/core';
import { GatewayModule } from './gateway.module';
import { configureGatewayHttp } from './gateway-http';

async function bootstrap() {
  process.env.SERVICE_NAME ??= 'gateway';
  const app = await NestFactory.create(GatewayModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  configureGatewayHttp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
