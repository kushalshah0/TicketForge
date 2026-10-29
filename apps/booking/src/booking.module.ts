import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { OUTBOX_DATABASE, OutboxRelay, OutboxService } from '@tf/outbox';
import { CatalogEventsConsumer } from './catalog-events.consumer';
import { BookingController } from './booking.controller';
import { PaymentEventsConsumer } from './payment-events.consumer';
import {
  BOOKING_DATABASE,
  BOOKING_POOL,
  BookingService,
  createBookingDatabase,
  createBookingPool,
} from './booking.service';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, CommonModule, MessagingModule],
  controllers: [BookingController, HealthController],
  providers: [
    BookingService,
    CatalogEventsConsumer,
    PaymentEventsConsumer,
    { provide: BOOKING_POOL, useFactory: createBookingPool },
    {
      provide: BOOKING_DATABASE,
      useFactory: createBookingDatabase,
      inject: [BOOKING_POOL],
    },
    { provide: OUTBOX_DATABASE, useExisting: BOOKING_DATABASE },
    OutboxRelay,
    OutboxService,
  ],
})
export class BookingModule {}
