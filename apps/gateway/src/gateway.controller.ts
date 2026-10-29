import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { GatewayThrottlerGuard } from './gateway-throttler.guard';
import { GatewayService } from './gateway.service';

@Controller()
@UseGuards(GatewayAuthGuard, GatewayThrottlerGuard)
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @All('api/*path')
  forward(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.gatewayService.forward(request, response);
  }
}
