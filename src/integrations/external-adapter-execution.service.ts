import { Injectable } from '@nestjs/common';
import { ExternalAdapterRegistry } from './external-adapter.registry';
import { ExternalAdapterRepository } from './external-adapter.repository';
import type {
  ExternalAdapterCapability,
  ExternalAdapterExecutionData,
  ExternalEmailTemplate,
  ExternalAdapterScenario,
  ExternalAdapterStatus,
  VersionedExternalAdapter,
} from './external-adapter.types';

@Injectable()
export class ExternalAdapterExecutionService {
  constructor(
    private readonly repository: ExternalAdapterRepository,
    private readonly registry: ExternalAdapterRegistry,
  ) {}

  async execute(input: {
    tenantId: string;
    capability: ExternalAdapterCapability;
    idempotencyKey: string;
    correlationId: string;
    scenario?: ExternalAdapterScenario;
    payload: {
      recipient: string;
      title: string;
      body: string;
      template: ExternalEmailTemplate;
    };
  }): Promise<ExternalAdapterExecutionData> {
    const config = await this.repository.config(
      input.tenantId,
      input.capability,
    );
    if (!config) throw new Error('ADAPTER_CONFIG_NOT_FOUND');
    const begun = await this.repository.beginExecution({
      tenantId: input.tenantId,
      config,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
    if (!begun.created) return begun.execution;
    if (!config.enabled)
      return this.repository.finishAttempt({
        tenantId: input.tenantId,
        executionId: begun.execution.id,
        status: 'REJECTED',
        attemptCount: 0,
        errorCode: 'ADAPTER_DISABLED',
        providerReference: null,
        durationMs: 0,
      });
    const adapter = this.registry.get({
      capability: config.capability,
      provider: config.provider,
      version: config.adapterVersion,
    });
    if (!adapter)
      return this.repository.finishAttempt({
        tenantId: input.tenantId,
        executionId: begun.execution.id,
        status: 'REJECTED',
        attemptCount: 0,
        errorCode: 'ADAPTER_NOT_CONFIGURED',
        providerReference: null,
        durationMs: 0,
      });

    const startedAt = Date.now();
    let status: Exclude<ExternalAdapterStatus, 'PENDING'> = 'RETRYABLE_FAILURE';
    let errorCode: string | null = 'ADAPTER_EXECUTION_FAILED';
    let providerReference: string | null = null;
    let attempt = 0;
    for (attempt = 1; attempt <= config.maxAttempts; attempt++) {
      const result = await this.attempt(adapter, {
        ...input,
        attempt,
        timeoutMs: config.timeoutMs,
        secretReference: config.secretReference,
      });
      status = result.status;
      errorCode = result.errorCode;
      providerReference = result.providerReference;
      if (status === 'SUCCEEDED' || status === 'REJECTED') break;
    }
    return this.repository.finishAttempt({
      tenantId: input.tenantId,
      executionId: begun.execution.id,
      status,
      attemptCount: Math.min(attempt, config.maxAttempts),
      errorCode,
      providerReference,
      durationMs: Date.now() - startedAt,
    });
  }

  private async attempt(
    adapter: VersionedExternalAdapter,
    input: {
      tenantId: string;
      capability: ExternalAdapterCapability;
      idempotencyKey: string;
      correlationId: string;
      attempt: number;
      timeoutMs: number;
      secretReference: string | null;
      scenario?: ExternalAdapterScenario;
      payload: {
        recipient: string;
        title: string;
        body: string;
        template: ExternalEmailTemplate;
      };
    },
  ): Promise<{
    status: Exclude<ExternalAdapterStatus, 'PENDING'>;
    errorCode: string | null;
    providerReference: string | null;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const result = await adapter.execute(
        {
          apiVersion: '1',
          tenantId: input.tenantId,
          capability: input.capability,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
          attempt: input.attempt,
          secretReference: input.secretReference,
          scenario: input.scenario,
          payload: input.payload,
        },
        controller.signal,
      );
      return result.status === 'SUCCEEDED'
        ? {
            status: 'SUCCEEDED',
            errorCode: null,
            providerReference: result.providerReference,
          }
        : {
            status: result.status,
            errorCode: result.errorCode,
            providerReference: null,
          };
    } catch {
      return controller.signal.aborted
        ? {
            status: 'TIMED_OUT',
            errorCode: 'ADAPTER_TIMEOUT',
            providerReference: null,
          }
        : {
            status: 'RETRYABLE_FAILURE',
            errorCode: 'ADAPTER_EXECUTION_FAILED',
            providerReference: null,
          };
    } finally {
      clearTimeout(timer);
    }
  }
}
