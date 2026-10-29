import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { GatewayHealthService } from './gateway-health.service';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly gatewayHealth: GatewayHealthService,
  ) {}

  @Get('api/health')
  apiHealth() {
    return this.gatewayHealth.getReport();
  }

  @Get('health/live')
  @HealthCheck()
  live() {
    return this.health.check([() => ({ app: { status: 'up' } })]);
  }

  @Get('health/ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => ({ app: { status: 'up' } })]);
  }
}
