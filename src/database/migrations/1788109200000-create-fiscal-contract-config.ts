import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFiscalContractConfig1788109200000 implements MigrationInterface {
  name = 'CreateFiscalContractConfig1788109200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE fiscal_tenant_configs (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        country_code CHAR(2) NOT NULL, contract_version VARCHAR(16) NOT NULL,
        provider_profile VARCHAR(24) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE,
        document_types JSON NOT NULL, tax_codes JSON NOT NULL,
        folio_mode VARCHAR(24) NOT NULL, tax_identifier VARCHAR(32) NULL,
        certificate_secret_reference VARCHAR(160) NULL,
        private_key_secret_reference VARCHAR(160) NULL,
        folio_authorization_secret_reference VARCHAR(160) NULL,
        environment VARCHAR(16) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_fiscal_tenant_config (tenant_id),
        CONSTRAINT fk_fiscal_tenant_config_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_fiscal_contract_version CHECK (contract_version = '1'),
        CONSTRAINT ck_fiscal_provider_profile CHECK (
          provider_profile IN ('SIMULATOR', 'LIVE_GENERIC')),
        CONSTRAINT ck_fiscal_folio_mode CHECK (
          folio_mode IN ('PROVIDER', 'LOCAL_AUTHORIZED')),
        CONSTRAINT ck_fiscal_environment CHECK (
          environment IS NULL OR environment IN ('TEST', 'PRODUCTION'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE fiscal_tenant_configs');
  }
}
