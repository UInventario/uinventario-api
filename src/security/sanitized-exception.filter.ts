import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { StructuredTelemetryService } from '../observability/structured-telemetry.service';
import {
  pseudonymizeTenant,
  resolveRequestRoute,
  resolveTraceContext,
} from '../observability/telemetry-context';
import type { RequestContext } from './request-context';

@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly telemetry: StructuredTelemetryService,
    private readonly deploymentEnvironment: string,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestContext>();
    const response = context.getResponse<unknown>();
    const adapter = this.adapterHost.httpAdapter;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      adapter.reply(
        response,
        typeof body === 'string' ? { statusCode: status, message: body } : body,
        status,
      );
      return;
    }

    this.telemetry.emit({
      severity: 'ERROR',
      event: 'unhandled_request_error',
      correlationId: request.requestId,
      ...resolveTraceContext(request),
      method: request.method,
      route: resolveRequestRoute(request),
      tenantRef: pseudonymizeTenant(
        request.principal?.tenant.id,
        this.deploymentEnvironment,
      ),
      errorType: exception instanceof Error ? exception.name : 'UnknownError',
    });
    adapter.reply(
      response,
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
