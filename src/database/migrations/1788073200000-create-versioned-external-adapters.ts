import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVersionedExternalAdapters1788073200000 implements MigrationInterface {
  name = 'CreateVersionedExternalAdapters1788073200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE external_adapter_configs (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        capability VARCHAR(40) NOT NULL, country_code CHAR(2) NOT NULL,
        provider_key VARCHAR(40) NOT NULL DEFAULT 'SIMULATOR',
        adapter_version VARCHAR(16) NOT NULL DEFAULT '1',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        timeout_ms INT UNSIGNED NOT NULL DEFAULT 1000,
        max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 2,
        secret_reference VARCHAR(160) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_external_adapter_configs_capability (tenant_id, capability),
        KEY ix_external_adapter_configs_selection
          (tenant_id, country_code, provider_key, adapter_version, enabled),
        CONSTRAINT fk_external_adapter_configs_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_external_adapter_configs_capability CHECK (
          capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH')
        ),
        CONSTRAINT ck_external_adapter_configs_timeout CHECK (
          timeout_ms BETWEEN 50 AND 30000
        ),
        CONSTRAINT ck_external_adapter_configs_attempts CHECK (
          max_attempts BETWEEN 1 AND 5
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE external_adapter_executions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        capability VARCHAR(40) NOT NULL, provider_key VARCHAR(40) NOT NULL,
        adapter_version VARCHAR(16) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(80) NULL,
        provider_reference VARCHAR(120) NULL,
        duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_external_adapter_executions_idempotency
          (tenant_id, capability, idempotency_key),
        KEY ix_external_adapter_executions_observability
          (tenant_id, status, updated_at),
        CONSTRAINT fk_external_adapter_executions_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_external_adapter_executions_capability CHECK (
          capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH')
        ),
        CONSTRAINT ck_external_adapter_executions_status CHECK (
          status IN ('PENDING', 'SUCCEEDED', 'REJECTED',
            'RETRYABLE_FAILURE', 'TIMED_OUT')
        ),
        CONSTRAINT ck_external_adapter_executions_attempts CHECK (
          attempt_count <= 5
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE external_adapter_executions');
    await queryRunner.query('DROP TABLE external_adapter_configs');
  }
}
