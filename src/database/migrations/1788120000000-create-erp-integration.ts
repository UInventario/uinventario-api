import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateErpIntegration1788120000000 implements MigrationInterface {
  name = 'CreateErpIntegration1788120000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE erp_external_mappings (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        provider VARCHAR(32) NOT NULL, resource VARCHAR(32) NOT NULL,
        external_id VARCHAR(100) NOT NULL, internal_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_erp_mapping_external (tenant_id, provider, resource, external_id),
        UNIQUE KEY uq_erp_mapping_internal (tenant_id, provider, resource, internal_id),
        KEY ix_erp_mapping_provider (tenant_id, provider, updated_at, id),
        CONSTRAINT fk_erp_mapping_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_erp_mapping_resource CHECK (resource IN (
          'PRODUCT', 'SUPPLIER', 'CUSTOMER', 'PURCHASE_ORDER', 'PURCHASE_RECEIPT', 'SALE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE erp_mapping_import_runs (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        provider VARCHAR(32) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL, status VARCHAR(16) NOT NULL,
        result JSON NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_erp_import_key (tenant_id, idempotency_key),
        KEY ix_erp_import_provider (tenant_id, provider, updated_at, id),
        CONSTRAINT fk_erp_import_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_erp_import_status CHECK (status IN ('PENDING', 'COMPLETED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE erp_mapping_import_runs');
    await queryRunner.query('DROP TABLE erp_external_mappings');
  }
}
