import { Module, type ExecutionContext } from '@nestjs/common';
import {
  ThrottlerModule,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthenticatedUser } from '@tf/common';
import { RedisThrottlerStorage } from './redis-throttler.storage';

type GatewayRequest = Request & { user?: AuthenticatedUser };

@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
class RedisThrottlerStorageModule {}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RedisThrottlerStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage): ThrottlerModuleOptions => {
        const allowlist = new Set(
          (process.env.LOAD_TEST_ALLOWLIST ?? '')
            .split(',')
            .map((ip) => ip.trim())
            .filter(Boolean),
        );
        const getRequest = (context: ExecutionContext) =>
          context.switchToHttp().getRequest<GatewayRequest>();
        const isAllowlisted = (request: GatewayRequest) =>
          allowlist.has(request.ip ?? '');
        const isAuthRequest = (request: GatewayRequest) =>
          request.path.startsWith('/api/auth/');
        const isBookingCreate = (request: GatewayRequest) =>
          request.method === 'POST' &&
          /^\/api\/bookings(?:\/|$)/.test(request.path);
        const getIp = (request: Record<string, any>) =>
          (request as unknown as GatewayRequest).ip ?? 'unknown';

        return {
          storage,
          throttlers: [
            {
              name: 'default',
              ttl: 60_000,
              limit: 100,
              blockDuration: 60_000,
              skipIf: (context) => isAllowlisted(getRequest(context)),
              getTracker: getIp,
            },
            {
              name: 'auth',
              ttl: 60_000,
              limit: 10,
              blockDuration: 60_000,
              skipIf: (context) => {
                const request = getRequest(context);
                return isAllowlisted(request) || !isAuthRequest(request);
              },
              getTracker: getIp,
            },
            {
              name: 'bookings',
              ttl: 60_000,
              limit: 20,
              blockDuration: 60_000,
              skipIf: (context) => {
                const request = getRequest(context);
                return isAllowlisted(request) || !isBookingCreate(request);
              },
              getTracker: (request) => {
                const gatewayRequest = request as unknown as GatewayRequest;
                return (
                  gatewayRequest.user?.sub ?? gatewayRequest.ip ?? 'unknown'
                );
              },
            },
          ],
        };
      },
    }),
  ],
  exports: [ThrottlerModule],
})
export class GatewayThrottlerModule {}
