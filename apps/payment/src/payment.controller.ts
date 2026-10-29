import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type AuthenticatedUser,
} from '@tf/common';
import { PaymentService } from './payment.service';

@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get()
  getHello(): string {
    return this.paymentService.getHello();
  }

  @Get('payments/by-booking/:bookingId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  getPaymentByBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
  ) {
    return this.paymentService.getPaymentByBooking(user.sub, bookingId);
  }

  @Post('payments/:id/pay')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: unknown,
  ) {
    return this.paymentService.pay(user.sub, paymentId, idempotencyKey, input);
  }
}
