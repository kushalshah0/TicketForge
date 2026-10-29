import { Module } from '@nestjs/common';
import { CommonModule } from '@tf/common';
import { MessagingService } from './messaging.service';

@Module({
  imports: [CommonModule],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
