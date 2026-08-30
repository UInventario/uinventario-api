import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAccountingInterface1788127200000 implements MigrationInterface {
  name = 'CreateAccountingInterface1788127200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE accounting_configs (
        tenant_id CHAR(36) NOT NULL, provider VARCHAR(32) NOT NULL,
        contract_version VARCHAR(16) NOT NULL,
        payment_clearing_account VARCHAR(64) NOT NULL,
        sales_revenue_account VARCHAR(64) NOT NULL,
        sales_returns_account VARCHAR(64) NOT NULL,
        tax_payable_account VARCHAR(64) NOT NULL,
        inventory_asset_account VARCHAR(64) NOT NULL,
        cost_of_goods_sold_account VARCHAR(64) NOT NULL,
        cash_account VARCHAR(64) NOT NULL,
        cash_clearing_account VARCHAR(64) NOT NULL,
        updated_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_accounting_config_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_accounting_config_user FOREIGN KEY (updated_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_accounting_config_provider CHECK
          (provider = 'SIMULATOR' AND contract_version = '1')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE accounting_events (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        event_key VARCHAR(100) NOT NULL, source_type VARCHAR(24) NOT NULL,
        source_id CHAR(36) NOT NULL, provider VARCHAR(32) NOT NULL,
        contract_version VARCHAR(16) NOT NULL, currency CHAR(3) NOT NULL,
        occurred_at DATETIME(6) NOT NULL, reference_key VARCHAR(120) NOT NULL,
        journal JSON NOT NULL, debit_total DECIMAL(18,2) NOT NULL,
        credit_total DECIMAL(18,2) NOT NULL, content_fingerprint CHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL, attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(80) NULL, provider_reference VARCHAR(120) NULL,
        generated_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_accounting_event_tenant_id (id, tenant_id),
        UNIQUE KEY uq_accounting_event_key (tenant_id, event_key),
        UNIQUE KEY uq_accounting_event_provider_ref (tenant_id, provider, provider_reference),
        KEY ix_accounting_event_status (tenant_id, status, occurred_at, id),
        CONSTRAINT fk_accounting_event_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_accounting_event_user FOREIGN KEY (generated_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_accounting_event_source CHECK
          (source_type IN ('SALE', 'SALE_VOID', 'SALE_RETURN', 'CASH_MOVEMENT')),
        CONSTRAINT ck_accounting_event_provider CHECK
          (provider = 'SIMULATOR' AND contract_version = '1'),
        CONSTRAINT ck_accounting_event_balance CHECK
          (debit_total >= 0 AND debit_total = credit_total),
        CONSTRAINT ck_accounting_event_status CHECK
          (status IN ('PENDING', 'EXPORTED', 'REJECTED', 'INDETERMINATE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE accounting_delivery_attempts (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        event_id CHAR(36) NOT NULL, action VARCHAR(16) NOT NULL,
        scenario VARCHAR(16) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL, result JSON NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_accounting_attempt_key (tenant_id, idempotency_key),
        KEY ix_accounting_attempt_event (tenant_id, event_id, created_at),
        CONSTRAINT fk_accounting_attempt_event FOREIGN KEY (event_id, tenant_id)
          REFERENCES accounting_events(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_accounting_attempt_action CHECK (action IN ('DELIVER', 'RECONCILE')),
        CONSTRAINT ck_accounting_attempt_scenario CHECK
          (scenario IN ('SUCCESS', 'REJECT', 'TIMEOUT', 'QUERY'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE accounting_delivery_attempts');
    await queryRunner.query('DROP TABLE accounting_events');
    await queryRunner.query('DROP TABLE accounting_configs');
  }
}
