import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestObservabilityInterceptor } from './request-observability.interceptor';
import { StructuredTelemetryService } from './structured-telemetry.service';

@Global()
@Module({
  providers: [
    StructuredTelemetryService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestObservabilityInterceptor,
    },
  ],
  exports: [StructuredTelemetryService],
})
export class ObservabilityModule {}
