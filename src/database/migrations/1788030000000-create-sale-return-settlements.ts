import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSaleReturnSettlements1788030000000 implements MigrationInterface {
  name = 'CreateSaleReturnSettlements1788030000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_payments
      ADD UNIQUE KEY uq_sale_payments_id_tenant (id, tenant_id)
    `);
    await queryRunner.query(`
      ALTER TABLE sale_returns
      DROP CHECK ck_sale_returns_values,
      ADD CONSTRAINT ck_sale_returns_values CHECK (
        CHAR_LENGTH(reason) >= 3
        AND settlement_status IN ('PENDING', 'PARTIALLY_SETTLED', 'SETTLED')
        AND subtotal >= 0 AND tax_total >= 0 AND total >= 0
        AND total = subtotal + tax_total
        AND (exchange_sale_id IS NULL OR exchange_sale_id <> sale_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sale_return_settlements (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        sale_return_id CHAR(36) NOT NULL,
        original_payment_id CHAR(36) NULL,
        cash_register_shift_id CHAR(36) NULL,
        mode VARCHAR(20) NOT NULL,
        method VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        currency CHAR(3) NOT NULL,
        amount DECIMAL(17,2) NOT NULL,
        provider VARCHAR(40) NOT NULL,
        provider_reference VARCHAR(120) NULL,
        failure_code VARCHAR(80) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        processed_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_return_settlements_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sale_return_settlements_key (tenant_id, idempotency_key),
        KEY ix_sale_return_settlements_return
          (tenant_id, sale_return_id, status, created_at),
        KEY ix_sale_return_settlements_payment
          (tenant_id, original_payment_id, status),
        KEY ix_sale_return_settlements_shift
          (tenant_id, cash_register_shift_id, status),
        CONSTRAINT fk_sale_return_settlements_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_settlements_return
          FOREIGN KEY (sale_return_id, tenant_id)
          REFERENCES sale_returns(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_settlements_payment
          FOREIGN KEY (original_payment_id, tenant_id)
          REFERENCES sale_payments(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_settlements_shift
          FOREIGN KEY (cash_register_shift_id, tenant_id)
          REFERENCES cash_register_shifts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_settlements_user
          FOREIGN KEY (processed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_return_settlements_values CHECK (
          mode IN ('REFUND', 'STORE_CREDIT')
          AND method IN ('CASH', 'CARD', 'TRANSFER', 'VOUCHER', 'STORE_CREDIT')
          AND status IN ('COMPLETED', 'FAILED')
          AND amount > 0
          AND (
            (mode = 'STORE_CREDIT' AND method = 'STORE_CREDIT'
              AND original_payment_id IS NULL AND cash_register_shift_id IS NULL)
            OR
            (mode = 'REFUND' AND method <> 'STORE_CREDIT'
              AND original_payment_id IS NOT NULL
              AND (method <> 'CASH' OR cash_register_shift_id IS NOT NULL))
          )
          AND ((status = 'COMPLETED' AND failure_code IS NULL)
            OR (status = 'FAILED' AND failure_code IS NOT NULL))
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_ledger (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL,
        sale_return_settlement_id CHAR(36) NOT NULL,
        entry_type VARCHAR(16) NOT NULL,
        currency CHAR(3) NOT NULL,
        amount DECIMAL(17,2) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_credit_ledger_settlement
          (tenant_id, sale_return_settlement_id),
        KEY ix_customer_credit_ledger_customer
          (tenant_id, customer_id, currency, created_at),
        CONSTRAINT fk_customer_credit_ledger_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_ledger_customer
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_ledger_settlement
          FOREIGN KEY (sale_return_settlement_id, tenant_id)
          REFERENCES sale_return_settlements(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_ledger_user
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_ledger_values CHECK (
          entry_type = 'CREDIT' AND amount > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer_credit_ledger');
    await queryRunner.query('DROP TABLE sale_return_settlements');
    await queryRunner.query(
      "UPDATE sale_returns SET settlement_status = 'PENDING'",
    );
    await queryRunner.query(`
      ALTER TABLE sale_returns
      DROP CHECK ck_sale_returns_values,
      ADD CONSTRAINT ck_sale_returns_values CHECK (
        CHAR_LENGTH(reason) >= 3
        AND settlement_status = 'PENDING'
        AND subtotal >= 0 AND tax_total >= 0 AND total >= 0
        AND total = subtotal + tax_total
        AND (exchange_sale_id IS NULL OR exchange_sale_id <> sale_id)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_payments DROP KEY uq_sale_payments_id_tenant
    `);
  }
}
