import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard, RolesGuard } from './auth';
import { CommonService } from './common.service';
import { CorrelationIdMiddleware } from './correlation';
import { ProblemDetailsFilter } from './errors';
import { pinoLoggerModule } from './logging';
import {
  MetricsController,
  MetricsInterceptor,
  MetricsService,
} from './metrics';

@Module({
  imports: [pinoLoggerModule],
  controllers: [MetricsController],
  providers: [
    CommonService,
    CorrelationIdMiddleware,
    JwtAuthGuard,
    RolesGuard,
    MetricsService,
    MetricsInterceptor,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [
    CommonService,
    CorrelationIdMiddleware,
    JwtAuthGuard,
    RolesGuard,
    MetricsService,
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
