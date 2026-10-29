import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { CommonModule } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { OUTBOX_DATABASE, OutboxRelay } from './outbox-relay';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {
  static forDatabase(
    databaseToken: string | symbol | Type<unknown>,
  ): DynamicModule {
    return {
      module: OutboxModule,
      imports: [CommonModule, MessagingModule],
      providers: [
        { provide: OUTBOX_DATABASE, useExisting: databaseToken },
        OutboxRelay,
      ],
      exports: [OutboxService, OutboxRelay],
    };
  }
}
