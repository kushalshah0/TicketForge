import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  SetMetadata,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errors, importSPKI, jwtVerify, decodeProtectedHeader } from 'jose';
import type { Request } from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError } from './errors';

export const ROLES_METADATA = 'ticketforge:roles';
export type UserRole = 'customer' | 'organizer' | 'admin';

export interface AuthenticatedUser {
  sub: string;
  role: UserRole;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

let publicKeyCache:
  { pem: string; key: ReturnType<typeof importSPKI> } | undefined;

export const Roles = (...roles: UserRole[]): ClassDecorator & MethodDecorator =>
  SetMetadata(ROLES_METADATA, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === 'string'
        ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
        : undefined;

    if (!token)
      throw new DomainError('Authentication required', 'UNAUTHORIZED', 401);

    let publicKeyPem = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
    const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH;
    const expectedKeyId = process.env.JWT_KEY_ID;
    const issuer = process.env.JWT_ISSUER;
    const audience = process.env.JWT_AUDIENCE;

    if (!publicKeyPem && publicKeyPath) {
      try {
        publicKeyPem = await readFile(resolve(publicKeyPath), 'utf8');
      } catch {
        throw new DomainError(
          'Token verification key is unavailable',
          'AUTH_CONFIG_ERROR',
          500,
        );
      }
    }

    if (!publicKeyPem || !expectedKeyId || !issuer || !audience) {
      throw new DomainError(
        'Token verification is not configured',
        'AUTH_CONFIG_ERROR',
        500,
      );
    }

    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'RS256' || header.kid !== expectedKeyId) {
        throw new DomainError('Invalid access token', 'INVALID_TOKEN', 401);
      }

      if (!publicKeyCache || publicKeyCache.pem !== publicKeyPem) {
        publicKeyCache = {
          pem: publicKeyPem,
          key: importSPKI(publicKeyPem, 'RS256'),
        };
      }
      const key = await publicKeyCache.key;
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer,
        audience,
      });

      if (
        typeof payload.sub !== 'string' ||
        !isUserRole(payload.role) ||
        typeof payload.exp !== 'number'
      ) {
        throw new DomainError('Invalid access token', 'INVALID_TOKEN', 401);
      }

      request.user = { sub: payload.sub, role: payload.role };
      return true;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof errors.JWTExpired) {
        throw new DomainError('Access token expired', 'TOKEN_EXPIRED', 401);
      }
      throw new DomainError('Invalid access token', 'INVALID_TOKEN', 401);
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_METADATA,
      [context.getHandler() as Type<unknown>, context.getClass()],
    );

    if (!requiredRoles?.length) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    return Boolean(user && requiredRoles.includes(user.role));
  }
}

function isUserRole(value: unknown): value is UserRole {
  return value === 'customer' || value === 'organizer' || value === 'admin';
}
