import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import type { RequestContext } from '../security/request-context';
import { StructuredTelemetryService } from './structured-telemetry.service';
import {
  pseudonymizeTenant,
  resolveOperation,
  resolveRequestRoute,
  resolveTraceContext,
} from './telemetry-context';

@Injectable()
export class RequestObservabilityInterceptor implements NestInterceptor {
  private readonly deploymentEnvironment: string;
  private readonly successSampleRate: number;

  constructor(
    config: ConfigService,
    private readonly telemetry: StructuredTelemetryService,
  ) {
    this.deploymentEnvironment = config.getOrThrow<string>(
      'app.deploymentEnvironment',
    );
    this.successSampleRate = config.getOrThrow<number>(
      'app.observabilitySuccessSampleRate',
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<RequestContext>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();

    const emit = (statusCode: number) => {
      if (statusCode < 400 && !this.shouldSample(request.requestId)) return;

      const route = resolveRequestRoute(request);
      const trace = resolveTraceContext(request);
      this.telemetry.emit({
        severity:
          statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARNING' : 'INFO',
        event: 'request_completed',
        correlationId: request.requestId,
        ...trace,
        tenantRef: pseudonymizeTenant(
          request.principal?.tenant.id,
          this.deploymentEnvironment,
        ),
        method: request.method,
        route,
        operation: resolveOperation(route),
        statusCode,
        outcome:
          statusCode >= 500
            ? 'server_error'
            : statusCode >= 400
              ? 'client_error'
              : 'success',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };

    return next.handle().pipe(
      tap({
        next: () => emit(response.statusCode),
        error: (error: unknown) =>
          emit(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }

  private shouldSample(requestId: string | undefined): boolean {
    if (this.successSampleRate >= 1) return true;
    if (this.successSampleRate <= 0) return false;
    const sample = createHash('sha256')
      .update(requestId ?? 'missing-request-id')
      .digest()
      .readUInt32BE(0);
    return sample / 0xffffffff < this.successSampleRate;
  }
}
