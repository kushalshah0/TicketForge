import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { DomainError, JwtAuthGuard, type AuthenticatedUser } from '@tf/common';
import { resolveGatewayRoute } from './gateway.service';

type AuthenticatedGatewayRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly jwtAuthGuard: JwtAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedGatewayRequest>();
    const pathname = new URL(request.originalUrl, 'http://gateway.local')
      .pathname;
    const route = resolveGatewayRoute(request.method, pathname);
    if (!route?.role) return true;

    await this.jwtAuthGuard.canActivate(context);
    if (route.role !== 'any' && request.user?.role !== route.role) {
      throw new DomainError('Insufficient permissions', 'FORBIDDEN', 403);
    }
    return true;
  }
}
