import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { OUTBOX_DATABASE, OutboxRelay, OutboxService } from '@tf/outbox';
import { BookingEventsConsumer } from './booking-events.consumer';
import { PaymentController } from './payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PAYMENT_PROVIDER, createPaymentProvider } from './payment-provider';
import {
  PAYMENT_DATABASE,
  PAYMENT_POOL,
  PaymentService,
  createPaymentDatabase,
  createPaymentPool,
} from './payment.service';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, CommonModule, MessagingModule],
  controllers: [PaymentController, PaymentWebhookController, HealthController],
  providers: [
    PaymentService,
    BookingEventsConsumer,
    { provide: PAYMENT_PROVIDER, useFactory: createPaymentProvider },
    { provide: PAYMENT_POOL, useFactory: createPaymentPool },
    {
      provide: PAYMENT_DATABASE,
      useFactory: createPaymentDatabase,
      inject: [PAYMENT_POOL],
    },
    { provide: OUTBOX_DATABASE, useExisting: PAYMENT_DATABASE },
    OutboxRelay,
    OutboxService,
  ],
})
export class PaymentModule {}
