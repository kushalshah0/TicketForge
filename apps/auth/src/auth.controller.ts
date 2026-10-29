import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  DomainError,
  JwtAuthGuard,
  type AuthenticatedUser,
} from '@tf/common';
import {
  AuthService,
  type AuthSession,
  type LoginInput,
  type RegisterInput,
  type RequestMetadata,
} from './auth.service';

const refreshCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60 * 1_000,
};

const clearRefreshCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/api/auth',
};

interface RefreshInput {
  refreshToken?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(
    @Body() input: RegisterInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.authService.register(
      input,
      getRequestMetadata(request),
    );
    return deliverSession(session, request, response);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.authService.login(
      input,
      getRequestMetadata(request),
    );
    return deliverSession(session, request, response);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() input: RefreshInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireCsrfHeader(request);
    const token = getRefreshToken(input, request);
    const session = await this.authService.refresh(
      token,
      getRequestMetadata(request),
    );
    return deliverSession(session, request, response);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() input: RefreshInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    requireCsrfHeader(request);
    const token = getRefreshToken(input, request, false);
    if (token) await this.authService.logout(token);
    response.clearCookie('refresh_token', clearRefreshCookieOptions);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser | undefined) {
    if (!user)
      throw new DomainError('Authentication required', 'UNAUTHORIZED', 401);
    return this.authService.getUser(user.sub);
  }
}

function getRequestMetadata(request: Request): RequestMetadata {
  return {
    ...(request.get('user-agent')
      ? { userAgent: request.get('user-agent') }
      : {}),
    ...(request.ip ? { ip: request.ip } : {}),
  };
}

function deliverSession(
  session: AuthSession,
  request: Request,
  response: Response,
) {
  if (request.headers['x-refresh-token-in-body'] === 'true') return session;

  response.cookie('refresh_token', session.refreshToken, refreshCookieOptions);
  return { user: session.user, accessToken: session.accessToken };
}

function requireCsrfHeader(request: Request): void {
  if (!request.get('x-requested-with')?.trim()) {
    throw new DomainError(
      'X-Requested-With header is required',
      'CSRF_REQUIRED',
      403,
    );
  }
}

function getRefreshToken(input: RefreshInput, request: Request): string;
function getRefreshToken(
  input: RefreshInput,
  request: Request,
  required: false,
): string | undefined;
function getRefreshToken(
  input: RefreshInput,
  request: Request,
  required = true,
): string | undefined {
  let token: string | undefined;
  if (request.headers['x-refresh-token-in-body'] === 'true') {
    token = input.refreshToken;
  } else if (typeof request.cookies?.refresh_token === 'string') {
    token = request.cookies.refresh_token;
  }
  if (typeof token === 'string' && token.length > 0) return token;
  if (!required) return undefined;
  throw new DomainError(
    'Refresh token is required',
    'INVALID_REFRESH_TOKEN',
    401,
  );
}
