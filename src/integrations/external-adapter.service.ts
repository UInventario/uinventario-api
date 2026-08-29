import { BadRequestException, Injectable } from '@nestjs/common';
import type { DiagnoseExternalAdapterDto } from './dto/diagnose-external-adapter.dto';
import type { ListExternalAdapterExecutionsDto } from './dto/list-external-adapter-executions.dto';
import type { UpdateExternalAdapterConfigDto } from './dto/update-external-adapter-config.dto';
import { ExternalAdapterExecutionService } from './external-adapter-execution.service';
import { ExternalAdapterRegistry } from './external-adapter.registry';
import { ExternalAdapterRepository } from './external-adapter.repository';
import {
  EXTERNAL_ADAPTER_CAPABILITIES,
  type ExternalAdapterCapability,
} from './external-adapter.types';

@Injectable()
export class ExternalAdapterService {
  constructor(
    private readonly repository: ExternalAdapterRepository,
    private readonly registry: ExternalAdapterRegistry,
    private readonly executor: ExternalAdapterExecutionService,
  ) {}

  async configurations(tenantId: string) {
    return {
      data: await this.repository.listConfigs(tenantId),
      meta: {
        apiVersion: '1' as const,
        catalog: this.registry.catalog(),
        secrets: {
          storage: 'EXTERNAL_SECRET_MANAGER',
          valuesAcceptedByApi: false,
        },
      },
    };
  }

  async update(
    tenantId: string,
    capabilityValue: string,
    dto: UpdateExternalAdapterConfigDto,
  ) {
    const capability = this.capability(capabilityValue);
    if (
      !this.registry.get({
        capability,
        provider: dto.provider,
        version: dto.adapterVersion,
      })
    ) {
      throw new BadRequestException('ADAPTER_SELECTION_NOT_SUPPORTED');
    }
    return {
      data: await this.repository.updateConfig(tenantId, capability, dto),
      meta: { apiVersion: '1' as const },
    };
  }

  async diagnose(input: {
    tenantId: string;
    capabilityValue: string;
    idempotencyKey: string;
    correlationId: string;
    dto: DiagnoseExternalAdapterDto;
  }) {
    const capability = this.capability(input.capabilityValue);
    return {
      data: await this.executor.execute({
        tenantId: input.tenantId,
        capability,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        scenario: input.dto.scenario,
        payload: {
          recipient: 'diagnostic@example.invalid',
          title: 'Diagnóstico de adaptador',
          body: 'Mensaje simulado sin datos de negocio.',
          template: { key: 'ADAPTER_DIAGNOSTIC', version: '1' },
        },
      }),
      meta: { apiVersion: '1' as const },
    };
  }

  async executions(tenantId: string, query: ListExternalAdapterExecutionsDto) {
    return {
      data: await this.repository.listExecutions(tenantId, query.status),
      meta: { apiVersion: '1' as const },
    };
  }

  async emailEvents(tenantId: string) {
    return {
      data: await this.repository.listEmailEvents(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  private capability(value: string): ExternalAdapterCapability {
    if (
      !EXTERNAL_ADAPTER_CAPABILITIES.includes(
        value as ExternalAdapterCapability,
      )
    )
      throw new BadRequestException('ADAPTER_CAPABILITY_NOT_SUPPORTED');
    return value as ExternalAdapterCapability;
  }
}
