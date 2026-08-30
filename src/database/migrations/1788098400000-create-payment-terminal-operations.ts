import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentTerminalOperations1788098400000 implements MigrationInterface {
  name = 'CreatePaymentTerminalOperations1788098400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payment_terminal_operations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL, cash_register_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        provider_key VARCHAR(40) NOT NULL,
        adapter_version VARCHAR(16) NOT NULL,
        provider_reference VARCHAR(120) NULL,
        amount DECIMAL(14,2) NOT NULL, currency CHAR(3) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        scenario VARCHAR(20) NOT NULL,
        error_code VARCHAR(80) NULL,
        authorization_code VARCHAR(80) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        query_count INT UNSIGNED NOT NULL DEFAULT 0,
        sale_id CHAR(36) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_payment_terminal_idempotency
          (tenant_id, idempotency_key),
        UNIQUE KEY uq_payment_terminal_provider_reference
          (tenant_id, provider_key, provider_reference),
        UNIQUE KEY uq_payment_terminal_sale (tenant_id, sale_id),
        KEY ix_payment_terminal_reconciliation
          (tenant_id, branch_id, status, updated_at),
        CONSTRAINT fk_payment_terminal_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_payment_terminal_branch FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_payment_terminal_cash_register FOREIGN KEY
          (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id)
          ON DELETE CASCADE,
        CONSTRAINT fk_payment_terminal_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_payment_terminal_sale FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_payment_terminal_amount CHECK (amount > 0),
        CONSTRAINT ck_payment_terminal_status CHECK (status IN
          ('PENDING', 'AUTHORIZED', 'CAPTURED', 'DECLINED',
           'INDETERMINATE', 'CANCELLED')),
        CONSTRAINT ck_payment_terminal_scenario CHECK (scenario IN
          ('SUCCESS', 'REJECT', 'INDETERMINATE')),
        CONSTRAINT ck_payment_terminal_capture CHECK (
          status NOT IN ('AUTHORIZED', 'CAPTURED') OR
          (provider_reference IS NOT NULL AND authorization_code IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE payment_terminal_operations');
  }
}
