import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { ErpExportQueryDto } from './dto/erp-export-query.dto';
import type { ImportErpMappingsDto } from './dto/import-erp-mappings.dto';
import { ErpIntegrationRepository } from './erp-integration.repository';
import { ERP_RESOURCES } from './erp-integration.types';

@Injectable()
export class ErpIntegrationService {
  constructor(
    private readonly repository: ErpIntegrationRepository,
    private readonly audit: AuditService,
  ) {}

  contract() {
    return {
      data: {
        name: 'UINVENTARIO_ERP_EXCHANGE',
        version: '1',
        mode: 'SIMULATOR',
        production: false,
        resources: ERP_RESOURCES.map((resource) => ({
          resource,
          directions: ['EXPORT_INCREMENTAL', 'IMPORT_IDENTITY_MAPPING'],
        })),
        guarantees: {
          tenantScoped: true,
          providerScoped: true,
          ordered: true,
          recordErrors: true,
          idempotentRetries: true,
          circularWritesPrevented: true,
        },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async export(tenantId: string, query: ErpExportQueryDto) {
    const cursor = this.decodeCursor(query.cursor, {
      tenantId,
      provider: query.provider,
      resource: query.resource,
    });
    const rows = await this.repository.exportRows({
      tenantId,
      provider: query.provider,
      resource: query.resource,
      cursor,
      limit: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => ({
        resource: query.resource,
        internalId: row.id,
        externalId: row.external_id,
        payload: this.json<Record<string, unknown>>(row.payload),
        changedAt: new Date(row.changed_at).toISOString(),
      })),
      meta: {
        apiVersion: '1' as const,
        provider: query.provider,
        resource: query.resource,
        hasMore,
        nextCursor: last
          ? Buffer.from(
              JSON.stringify({
                tenantId,
                provider: query.provider,
                resource: query.resource,
                changedAt: last.changed_cursor,
                id: last.id,
              }),
            ).toString('base64url')
          : (query.cursor ?? null),
      },
    };
  }

  async import(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string;
    dto: ImportErpMappingsDto;
  }) {
    this.key(input.idempotencyKey);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input.dto))
      .digest('hex');
    const result = await this.repository.importMappings({
      tenantId: input.tenantId,
      provider: input.dto.provider,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      records: input.dto.records,
    });
    const linked = result.results.filter(
      ({ status }) => status === 'LINKED',
    ).length;
    const failed = result.results.length - linked;
    if (!result.replay) {
      await this.audit.recordRequired({
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'ERP_MAPPING_BATCH_IMPORTED',
        entityType: 'ERP_MAPPING_IMPORT_RUN',
        entityId: result.runId,
        correlationId: input.correlationId,
        after: {
          provider: input.dto.provider,
          records: result.results.length,
          linked,
          failed,
        },
      });
    }
    return {
      data: {
        runId: result.runId,
        status: 'COMPLETED' as const,
        summary: { total: result.results.length, linked, failed },
        results: result.results,
      },
      meta: {
        apiVersion: '1' as const,
        provider: input.dto.provider,
        idempotentReplay: result.replay,
      },
    };
  }

  async mappings(tenantId: string, providerValue: string) {
    const provider = this.provider(providerValue);
    const mappings = await this.repository.mappings(tenantId, provider);
    return {
      data: mappings.map((mapping) => ({
        id: mapping.id,
        resource: mapping.resource,
        externalId: mapping.external_id,
        internalId: mapping.internal_id,
        createdAt: new Date(mapping.created_at).toISOString(),
        updatedAt: new Date(mapping.updated_at).toISOString(),
      })),
      meta: { apiVersion: '1' as const, provider },
    };
  }

  async runs(tenantId: string, providerValue: string) {
    const provider = this.provider(providerValue);
    return {
      data: await this.repository.runs(tenantId, provider),
      meta: { apiVersion: '1' as const, provider },
    };
  }

  private decodeCursor(
    value: string | undefined,
    scope: { tenantId: string; provider: string; resource: string },
  ) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
        tenantId?: unknown;
        provider?: unknown;
        resource?: unknown;
        changedAt?: unknown;
        id?: unknown;
      };
      if (
        parsed.tenantId !== scope.tenantId ||
        parsed.provider !== scope.provider ||
        parsed.resource !== scope.resource ||
        typeof parsed.changedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(
          parsed.changedAt,
        ) ||
        typeof parsed.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(parsed.id)
      ) {
        throw new Error();
      }
      return { changedAt: parsed.changedAt, id: parsed.id };
    } catch {
      throw new BadRequestException('ERP_CURSOR_INVALID');
    }
  }

  private provider(value: string): string {
    if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(value)) {
      throw new BadRequestException('ERP_PROVIDER_INVALID');
    }
    return value;
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }
}
