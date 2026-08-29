import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { UpdateExternalAdapterConfigDto } from './dto/update-external-adapter-config.dto';
import type {
  ExternalAdapterCapability,
  ExternalAdapterConfigData,
  ExternalAdapterExecutionData,
  ExternalAdapterStatus,
  ExternalEmailEventData,
  ExternalEmailEventType,
} from './external-adapter.types';

interface ConfigRow {
  id: string;
  capability: ExternalAdapterCapability;
  country_code: string;
  provider_key: string;
  adapter_version: string;
  enabled: number | boolean;
  timeout_ms: number | string;
  max_attempts: number | string;
  secret_reference: string | null;
  updated_at: Date | string;
}

interface ExecutionRow {
  id: string;
  capability: ExternalAdapterCapability;
  provider_key: string;
  adapter_version: string;
  idempotency_key: string;
  correlation_id: string;
  status: ExternalAdapterStatus;
  attempt_count: number | string;
  error_code: string | null;
  provider_reference: string | null;
  duration_ms: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EmailEventRow {
  webhook_event_id: string;
  provider_key: string;
  provider_reference: string;
  event_type: ExternalEmailEventType;
  error_code: string | null;
  occurred_at: Date | string;
  received_at: Date | string;
}

@Injectable()
export class ExternalAdapterRepository {
  constructor(private readonly dataSource: DataSource) {}

  async ensureDefaults(tenantId: string): Promise<void> {
    await this.dataSource.query(
      `INSERT IGNORE INTO external_adapter_configs
         (id, tenant_id, capability, country_code, provider_key,
          adapter_version, enabled, timeout_ms, max_attempts)
       SELECT UUID(), tenant.id, capability.code,
              COALESCE(tenant.country_code, 'MX'), 'SIMULATOR', '1', TRUE, 1000, 2
       FROM tenants tenant
       CROSS JOIN (
         SELECT 'NOTIFICATION_EMAIL' AS code
         UNION ALL SELECT 'NOTIFICATION_PUSH'
       ) capability
       WHERE tenant.id = ?`,
      [tenantId],
    );
  }

  async listConfigs(tenantId: string): Promise<ExternalAdapterConfigData[]> {
    await this.ensureDefaults(tenantId);
    const rows = await this.dataSource.query<ConfigRow[]>(
      `SELECT id, capability, country_code, provider_key, adapter_version,
              enabled, timeout_ms, max_attempts, secret_reference, updated_at
       FROM external_adapter_configs WHERE tenant_id = ?
       ORDER BY capability`,
      [tenantId],
    );
    return rows.map((row) => this.toConfig(row));
  }

  async config(
    tenantId: string,
    capability: ExternalAdapterCapability,
  ): Promise<ExternalAdapterConfigData | null> {
    await this.ensureDefaults(tenantId);
    const [row] = await this.dataSource.query<ConfigRow[]>(
      `SELECT id, capability, country_code, provider_key, adapter_version,
              enabled, timeout_ms, max_attempts, secret_reference, updated_at
       FROM external_adapter_configs
       WHERE tenant_id = ? AND capability = ? LIMIT 1`,
      [tenantId, capability],
    );
    return row ? this.toConfig(row) : null;
  }

  async updateConfig(
    tenantId: string,
    capability: ExternalAdapterCapability,
    dto: UpdateExternalAdapterConfigDto,
  ): Promise<ExternalAdapterConfigData> {
    await this.ensureDefaults(tenantId);
    await this.dataSource.query(
      `UPDATE external_adapter_configs SET country_code = ?, provider_key = ?,
         adapter_version = ?, enabled = ?, timeout_ms = ?, max_attempts = ?,
         secret_reference = ?
       WHERE tenant_id = ? AND capability = ?`,
      [
        dto.countryCode.toUpperCase(),
        dto.provider,
        dto.adapterVersion,
        dto.enabled,
        dto.timeoutMs,
        dto.maxAttempts,
        dto.secretReference?.trim() || null,
        tenantId,
        capability,
      ],
    );
    return (await this.config(tenantId, capability))!;
  }

  async beginExecution(input: {
    tenantId: string;
    config: ExternalAdapterConfigData;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<{ execution: ExternalAdapterExecutionData; created: boolean }> {
    const id = randomUUID();
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `INSERT IGNORE INTO external_adapter_executions
         (id, tenant_id, capability, provider_key, adapter_version,
          idempotency_key, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.config.capability,
        input.config.provider,
        input.config.adapterVersion,
        input.idempotencyKey,
        input.correlationId,
      ],
    );
    const [row] = await this.dataSource.query<ExecutionRow[]>(
      `SELECT id, capability, provider_key, adapter_version, idempotency_key,
              correlation_id, status, attempt_count, error_code,
              provider_reference, duration_ms, created_at, updated_at
       FROM external_adapter_executions
       WHERE tenant_id = ? AND capability = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.config.capability, input.idempotencyKey],
    );
    return {
      execution: this.toExecution(row),
      created: Number(result.affectedRows ?? 0) === 1,
    };
  }

  async finishAttempt(input: {
    tenantId: string;
    executionId: string;
    status: Exclude<ExternalAdapterStatus, 'PENDING'>;
    attemptCount: number;
    errorCode: string | null;
    providerReference: string | null;
    durationMs: number;
  }): Promise<ExternalAdapterExecutionData> {
    await this.dataSource.query(
      `UPDATE external_adapter_executions
       SET status = ?, attempt_count = ?, error_code = ?,
           provider_reference = ?, duration_ms = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        input.status,
        input.attemptCount,
        input.errorCode,
        input.providerReference,
        input.durationMs,
        input.executionId,
        input.tenantId,
      ],
    );
    const [row] = await this.dataSource.query<ExecutionRow[]>(
      `SELECT id, capability, provider_key, adapter_version, idempotency_key,
              correlation_id, status, attempt_count, error_code,
              provider_reference, duration_ms, created_at, updated_at
       FROM external_adapter_executions WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [input.executionId, input.tenantId],
    );
    return this.toExecution(row);
  }

  async listExecutions(
    tenantId: string,
    status?: ExternalAdapterStatus,
  ): Promise<ExternalAdapterExecutionData[]> {
    const parameters = status ? [tenantId, status] : [tenantId];
    const rows = await this.dataSource.query<ExecutionRow[]>(
      `SELECT id, capability, provider_key, adapter_version, idempotency_key,
              correlation_id, status, attempt_count, error_code,
              provider_reference, duration_ms, created_at, updated_at
       FROM external_adapter_executions WHERE tenant_id = ?
         ${status ? 'AND status = ?' : ''}
       ORDER BY updated_at DESC LIMIT 100`,
      parameters,
    );
    return rows.map((row) => this.toExecution(row));
  }

  async recordEmailEvent(input: {
    webhookEventId: string;
    provider: string;
    providerReference: string;
    eventType: ExternalEmailEventType;
    errorCode: string | null;
    occurredAt: Date;
  }): Promise<boolean> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `INSERT IGNORE INTO external_email_events
         (webhook_event_id, tenant_id, provider_key, provider_reference,
          event_type, error_code, occurred_at)
       SELECT ?, execution.tenant_id, ?, ?, ?, ?, ?
       FROM external_adapter_executions execution
       WHERE execution.provider_key = ? AND execution.provider_reference = ?
       ORDER BY execution.updated_at DESC LIMIT 1`,
      [
        input.webhookEventId,
        input.provider,
        input.providerReference,
        input.eventType,
        input.errorCode,
        input.occurredAt,
        input.provider,
        input.providerReference,
      ],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  async listEmailEvents(tenantId: string): Promise<ExternalEmailEventData[]> {
    const rows = await this.dataSource.query<EmailEventRow[]>(
      `SELECT webhook_event_id, provider_key, provider_reference,
              event_type, error_code, occurred_at, received_at
       FROM external_email_events WHERE tenant_id = ?
       ORDER BY occurred_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      webhookEventId: row.webhook_event_id,
      provider: row.provider_key,
      providerReference: row.provider_reference,
      eventType: row.event_type,
      errorCode: row.error_code,
      occurredAt: new Date(row.occurred_at).toISOString(),
      receivedAt: new Date(row.received_at).toISOString(),
    }));
  }

  private toConfig(row: ConfigRow): ExternalAdapterConfigData {
    return {
      id: row.id,
      capability: row.capability,
      countryCode: row.country_code,
      provider: row.provider_key,
      adapterVersion: row.adapter_version,
      enabled: Boolean(row.enabled),
      timeoutMs: Number(row.timeout_ms),
      maxAttempts: Number(row.max_attempts),
      secretReference: row.secret_reference,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private toExecution(row: ExecutionRow): ExternalAdapterExecutionData {
    return {
      id: row.id,
      capability: row.capability,
      provider: row.provider_key,
      adapterVersion: row.adapter_version,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      errorCode: row.error_code,
      providerReference: row.provider_reference,
      durationMs: Number(row.duration_ms),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
