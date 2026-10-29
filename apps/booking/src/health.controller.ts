import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([() => ({ app: { status: 'up' } })]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => ({ app: { status: 'up' } })]);
  }
}
