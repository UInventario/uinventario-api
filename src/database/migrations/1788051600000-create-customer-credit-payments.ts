import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCustomerCreditPayments1788051600000 implements MigrationInterface {
  name = 'CreateCustomerCreditPayments1788051600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE customer_credit_installments
      ADD UNIQUE KEY uq_customer_credit_installments_id_tenant (id, tenant_id)
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_payments (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL,
        cash_register_shift_id CHAR(36) NOT NULL,
        cash_movement_id CHAR(36) NULL,
        reversal_cash_movement_id CHAR(36) NULL,
        receipt_number VARCHAR(40) NOT NULL,
        currency CHAR(3) NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        method VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        external_reference VARCHAR(120) NULL,
        provider VARCHAR(40) NOT NULL,
        provider_reference VARCHAR(120) NULL,
        authorization_code VARCHAR(80) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        reversal_reason VARCHAR(160) NULL,
        reversal_provider_reference VARCHAR(120) NULL,
        reversal_idempotency_key VARCHAR(128) NULL,
        reversal_request_fingerprint CHAR(64) NULL,
        reversed_by_user_id CHAR(36) NULL,
        reversed_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_credit_payments_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customer_credit_payments_receipt (tenant_id, receipt_number),
        UNIQUE KEY uq_customer_credit_payments_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_customer_credit_payments_reversal_key
          (tenant_id, reversal_idempotency_key),
        UNIQUE KEY uq_customer_credit_payments_cash_movement
          (tenant_id, cash_movement_id),
        UNIQUE KEY uq_customer_credit_payments_reversal_cash_movement
          (tenant_id, reversal_cash_movement_id),
        KEY ix_customer_credit_payments_customer
          (tenant_id, customer_id, created_at),
        KEY ix_customer_credit_payments_shift
          (tenant_id, cash_register_shift_id, created_at),
        CONSTRAINT fk_customer_credit_payments_customer
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payments_shift
          FOREIGN KEY (cash_register_shift_id, tenant_id)
          REFERENCES cash_register_shifts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payments_cash_movement
          FOREIGN KEY (cash_movement_id, tenant_id)
          REFERENCES cash_register_movements(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payments_reversal_cash_movement
          FOREIGN KEY (reversal_cash_movement_id, tenant_id)
          REFERENCES cash_register_movements(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payments_created_user
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payments_reversed_user
          FOREIGN KEY (reversed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_payments_values CHECK (
          amount > 0 AND currency REGEXP '^[A-Z]{3}$'
          AND method IN ('CASH', 'CARD', 'TRANSFER')
          AND status IN ('COMPLETED', 'REVERSED')
          AND (
            (method = 'CASH' AND external_reference IS NULL
              AND provider = 'CASH' AND provider_reference IS NULL
              AND authorization_code IS NULL AND cash_movement_id IS NOT NULL)
            OR
            (method IN ('CARD', 'TRANSFER') AND external_reference IS NOT NULL
              AND provider_reference IS NOT NULL
              AND authorization_code IS NOT NULL AND cash_movement_id IS NULL)
          )
          AND (
            (status = 'COMPLETED' AND reversal_reason IS NULL
              AND reversal_provider_reference IS NULL
              AND reversal_cash_movement_id IS NULL
              AND reversal_idempotency_key IS NULL
              AND reversal_request_fingerprint IS NULL
              AND reversed_by_user_id IS NULL AND reversed_at IS NULL)
            OR
            (status = 'REVERSED' AND reversal_reason IS NOT NULL
              AND reversal_idempotency_key IS NOT NULL
              AND reversal_request_fingerprint IS NOT NULL
              AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL
              AND ((method = 'CASH' AND reversal_cash_movement_id IS NOT NULL)
                OR (method <> 'CASH' AND reversal_cash_movement_id IS NULL
                  AND reversal_provider_reference IS NOT NULL)))
          )
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_payment_allocations (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        payment_id CHAR(36) NOT NULL,
        account_id CHAR(36) NOT NULL,
        installment_id CHAR(36) NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_credit_payment_allocations_installment
          (tenant_id, payment_id, installment_id),
        KEY ix_customer_credit_payment_allocations_account
          (tenant_id, account_id, created_at),
        KEY ix_customer_credit_payment_allocations_installment
          (tenant_id, installment_id, created_at),
        CONSTRAINT fk_customer_credit_payment_allocations_payment
          FOREIGN KEY (payment_id, tenant_id)
          REFERENCES customer_credit_payments(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payment_allocations_account
          FOREIGN KEY (account_id, tenant_id)
          REFERENCES customer_credit_accounts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_payment_allocations_installment
          FOREIGN KEY (installment_id, tenant_id)
          REFERENCES customer_credit_installments(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_payment_allocations_amount CHECK (amount > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer_credit_payment_allocations');
    await queryRunner.query('DROP TABLE customer_credit_payments');
    await queryRunner.query(`
      ALTER TABLE customer_credit_installments
      DROP KEY uq_customer_credit_installments_id_tenant
    `);
  }
}
