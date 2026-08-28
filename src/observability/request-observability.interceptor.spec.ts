import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { RequestContext } from '../security/request-context';
import { RequestObservabilityInterceptor } from './request-observability.interceptor';
import {
  StructuredTelemetryService,
  type TelemetryEvent,
} from './structured-telemetry.service';

describe('RequestObservabilityInterceptor', () => {
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'app.deploymentEnvironment' ? 'test' : 1,
    ),
  } as unknown as ConfigService;
  const emit = jest.fn<void, [TelemetryEvent]>();
  const telemetry = { emit } as unknown as StructuredTelemetryService;
  const interceptor = new RequestObservabilityInterceptor(config, telemetry);

  function context(statusCode = 200) {
    const request = {
      requestId: 'observability-correlation-2026',
      method: 'POST',
      baseUrl: '/api/v1/offline',
      route: { path: '/commands' },
      principal: {
        tenant: { id: 'real-tenant-id' },
      },
      header: jest.fn((name: string) =>
        name === 'x-cloud-trace-context'
          ? '0123456789abcdef0123456789abcdef/42;o=1'
          : undefined,
      ),
    } as unknown as RequestContext;
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode }),
      }),
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it('emits a correlated structured success without exposing the tenant id', async () => {
    await lastValueFrom(
      interceptor.intercept(context() as never, { handle: () => of('ok') }),
    );

    const event = emit.mock.calls[0][0];
    expect(event).toMatchObject({
      event: 'request_completed',
      correlationId: 'observability-correlation-2026',
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '42',
      operation: 'offline_sync',
      outcome: 'success',
    });
    expect(event.tenantRef).toMatch(/^tenant_[a-f0-9]{16}$/);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('real-tenant-id');
  });

  it('always emits an injected critical-queue failure', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(context() as never, {
          handle: () => throwError(() => new Error('database secret')),
        }),
      ),
    ).rejects.toThrow('database secret');

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'ERROR',
        operation: 'offline_sync',
        outcome: 'server_error',
        statusCode: 500,
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('database secret');
  });

  it('records expected HTTP failures as client errors', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(context() as never, {
          handle: () => throwError(() => new HttpException('not allowed', 403)),
        }),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'WARNING',
        outcome: 'client_error',
        statusCode: 403,
      }),
    );
  });
});
