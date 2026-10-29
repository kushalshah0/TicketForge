import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { NotificationController } from './notification.controller';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { HealthController } from './health.controller';
import {
  createNotificationDatabase,
  createNotificationPool,
  NOTIFICATION_DATABASE,
  NOTIFICATION_POOL,
  NotificationService,
} from './notification.service';

@Module({
  imports: [TerminusModule, CommonModule, MessagingModule],
  controllers: [NotificationController, HealthController],
  providers: [
    NotificationService,
    NotificationEventsConsumer,
    { provide: NOTIFICATION_POOL, useFactory: createNotificationPool },
    {
      provide: NOTIFICATION_DATABASE,
      useFactory: createNotificationDatabase,
      inject: [NOTIFICATION_POOL],
    },
  ],
})
export class NotificationModule {}
