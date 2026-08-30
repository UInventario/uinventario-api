import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSaleFiscalDocuments1788116400000 implements MigrationInterface {
  name = 'CreateSaleFiscalDocuments1788116400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sale_fiscal_documents (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL, receipt_number VARCHAR(64) NOT NULL,
        document_type VARCHAR(24) NOT NULL, scenario VARCHAR(16) NOT NULL,
        status VARCHAR(24) NOT NULL, simulator_document_id CHAR(36) NULL,
        provider_reference VARCHAR(80) NULL, error_code VARCHAR(80) NULL,
        provider_idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_fiscal_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sale_fiscal_sale (tenant_id, sale_id),
        UNIQUE KEY uq_sale_fiscal_provider_key (tenant_id, provider_idempotency_key),
        UNIQUE KEY uq_sale_fiscal_simulator (tenant_id, simulator_document_id),
        KEY ix_sale_fiscal_branch_status (tenant_id, branch_id, status, updated_at),
        CONSTRAINT fk_sale_fiscal_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_fiscal_branch FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_fiscal_sale FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_fiscal_simulator FOREIGN KEY (simulator_document_id, tenant_id)
          REFERENCES fiscal_simulator_documents(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_fiscal_scenario CHECK (scenario IN ('SUCCESS', 'REJECT', 'TIMEOUT')),
        CONSTRAINT ck_sale_fiscal_status CHECK (
          status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'INDETERMINATE', 'CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sale_fiscal_document_events (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, document_id CHAR(36) NOT NULL,
        status VARCHAR(24) NOT NULL,
        occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_fiscal_event_status (tenant_id, document_id, status),
        CONSTRAINT fk_sale_fiscal_event_document FOREIGN KEY (document_id, tenant_id)
          REFERENCES sale_fiscal_documents(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_fiscal_event_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_sale_fiscal_event_status CHECK (
          status IN ('PENDING', 'SENT', 'ACCEPTED', 'REJECTED', 'INDETERMINATE', 'CANCELLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sale_fiscal_document_events');
    await queryRunner.query('DROP TABLE sale_fiscal_documents');
  }
}
