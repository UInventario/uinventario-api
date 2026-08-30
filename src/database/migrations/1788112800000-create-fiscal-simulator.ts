import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFiscalSimulator1788112800000 implements MigrationInterface {
  name = 'CreateFiscalSimulator1788112800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE fiscal_simulator_documents (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        country_code CHAR(2) NOT NULL, contract_version VARCHAR(16) NOT NULL,
        document_type VARCHAR(24) NOT NULL, reference_key VARCHAR(80) NOT NULL,
        provider_reference VARCHAR(80) NOT NULL, scenario VARCHAR(16) NOT NULL,
        status VARCHAR(24) NOT NULL, poll_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(80) NULL, pdf_base64 LONGTEXT NULL, xml_base64 LONGTEXT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_fiscal_simulator_id_tenant (id, tenant_id),
        UNIQUE KEY uq_fiscal_simulator_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_fiscal_simulator_provider_ref (tenant_id, provider_reference),
        KEY ix_fiscal_simulator_status (tenant_id, status, updated_at),
        CONSTRAINT fk_fiscal_simulator_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_fiscal_simulator_scenario CHECK (
          scenario IN ('SUCCESS', 'REJECT', 'TIMEOUT')),
        CONSTRAINT ck_fiscal_simulator_status CHECK (
          status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'INDETERMINATE', 'CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE fiscal_simulator_operations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, document_id CHAR(36) NOT NULL,
        action VARCHAR(16) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
        fingerprint CHAR(64) NOT NULL, result JSON NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_fiscal_simulator_operation (tenant_id, idempotency_key),
        CONSTRAINT fk_fiscal_simulator_operation_document
          FOREIGN KEY (document_id, tenant_id)
          REFERENCES fiscal_simulator_documents(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_fiscal_simulator_operation_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_fiscal_simulator_action CHECK (action IN ('QUERY', 'CANCEL'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE fiscal_simulator_callbacks (
        event_id VARCHAR(128) NOT NULL, tenant_id CHAR(36) NOT NULL,
        document_id CHAR(36) NOT NULL, status VARCHAR(24) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, event_id),
        CONSTRAINT fk_fiscal_simulator_callback_document
          FOREIGN KEY (document_id, tenant_id)
          REFERENCES fiscal_simulator_documents(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_fiscal_simulator_callback_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_fiscal_simulator_callback_status CHECK (status IN ('ACCEPTED', 'REJECTED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE fiscal_simulator_callbacks');
    await queryRunner.query('DROP TABLE fiscal_simulator_operations');
    await queryRunner.query('DROP TABLE fiscal_simulator_documents');
  }
}
