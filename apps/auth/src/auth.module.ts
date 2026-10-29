import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CommonModule, createDrizzle } from '@tf/common';
import { MessagingModule } from '@tf/messaging';
import { OUTBOX_DATABASE, OutboxRelay, OutboxService } from '@tf/outbox';
import { AuthController } from './auth.controller';
import { AUTH_POOL, AuthService, createAuthPool } from './auth.service';
import { HealthController } from './health.controller';

const AUTH_DRIZZLE = Symbol('AUTH_DRIZZLE');

@Module({
  imports: [TerminusModule, CommonModule, MessagingModule],
  controllers: [AuthController, HealthController],
  providers: [
    AuthService,
    { provide: AUTH_POOL, useFactory: createAuthPool },
    { provide: AUTH_DRIZZLE, useFactory: createDrizzle, inject: [AUTH_POOL] },
    { provide: OUTBOX_DATABASE, useExisting: AUTH_DRIZZLE },
    OutboxRelay,
    OutboxService,
  ],
})
export class AuthModule {}
