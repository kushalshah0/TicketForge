import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule } from '@tf/common';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { GatewayController } from './gateway.controller';
import { GatewayHealthService } from './gateway-health.service';
import { GatewayThrottlerGuard } from './gateway-throttler.guard';
import { GatewayThrottlerModule } from './redis-throttler.module';
import { GatewayService } from './gateway.service';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, CommonModule, GatewayThrottlerModule],
  controllers: [HealthController, GatewayController],
  providers: [
    GatewayAuthGuard,
    GatewayHealthService,
    GatewayService,
    GatewayThrottlerGuard,
  ],
})
export class GatewayModule {}
