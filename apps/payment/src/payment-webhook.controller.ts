import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { MetricsService } from '@tf/common';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';
import { PaymentService } from './payment.service';

@Controller('internal/webhooks')
export class PaymentWebhookController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly paymentService: PaymentService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Post('mock')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-mock-signature') signature: string | undefined,
    @Body() payload: unknown,
  ): Promise<{ received: true }> {
    if (
      !request.rawBody ||
      !this.provider.verifyWebhook(request.rawBody, signature)
    ) {
      this.metrics?.paymentWebhooks.inc({ result: 'invalid_signature' });
      throw new UnauthorizedException('Invalid webhook signature');
    }
    try {
      await this.paymentService.handleWebhook(payload);
      this.metrics?.paymentWebhooks.inc({ result: 'success' });
      return { received: true };
    } catch (error) {
      this.metrics?.paymentWebhooks.inc({ result: 'error' });
      throw error;
    }
  }
}
