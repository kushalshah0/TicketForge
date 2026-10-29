import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { OUTBOX_DATABASE, OutboxRelay, OutboxService } from '@tf/outbox';
import { CatalogController } from './catalog.controller';
import {
  CATALOG_DATABASE,
  CATALOG_POOL,
  CatalogService,
  createCatalogDatabase,
  createCatalogPool,
} from './catalog.service';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, CommonModule, MessagingModule],
  controllers: [CatalogController, HealthController],
  providers: [
    CatalogService,
    { provide: CATALOG_POOL, useFactory: createCatalogPool },
    {
      provide: CATALOG_DATABASE,
      useFactory: createCatalogDatabase,
      inject: [CATALOG_POOL],
    },
    { provide: OUTBOX_DATABASE, useExisting: CATALOG_DATABASE },
    OutboxRelay,
    OutboxService,
  ],
})
export class CatalogModule {}
