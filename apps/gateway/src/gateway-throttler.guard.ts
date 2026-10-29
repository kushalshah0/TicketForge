import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

@Injectable()
export class GatewayThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  protected setResponseHeader(
    response: Record<string, any>,
    name: string,
    value: string | number,
  ): void {
    super.setResponseHeader(response, name, value);
    if (name.startsWith('Retry-After-')) {
      super.setResponseHeader(response, 'Retry-After', value);
    }
  }
}
