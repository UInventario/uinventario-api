import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCustomerCreditSales1788048000000 implements MigrationInterface {
  name = 'CreateCustomerCreditSales1788048000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALES_CREDIT', 'SALE_REPRINT',
        'CASH_DRAWER_OPEN', 'CASH_REGISTER_OPEN', 'CASH_REGISTER_CLOSE',
        'CASH_REGISTER_MOVE', 'ACCESS_MANAGE', 'AUDIT_VIEW', 'AUDIT_EXPORT',
        'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE', 'PURCHASE_ORDERS_MANAGE',
        'PURCHASE_ORDERS_APPROVE', 'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'SALES_CREDIT' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_profiles (
        customer_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        credit_limit DECIMAL(14,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        term_days SMALLINT UNSIGNED NOT NULL,
        max_installments SMALLINT UNSIGNED NOT NULL,
        configured_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (customer_id),
        UNIQUE KEY uq_customer_credit_profiles_tenant (customer_id, tenant_id),
        KEY ix_customer_credit_profiles_tenant (tenant_id, enabled),
        CONSTRAINT fk_customer_credit_profiles_customer
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_customer_credit_profiles_user
          FOREIGN KEY (configured_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_profiles_values CHECK (
          credit_limit > 0 AND currency REGEXP '^[A-Z]{3}$'
          AND term_days BETWEEN 1 AND 365
          AND max_installments BETWEEN 1 AND 36
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_accounts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL,
        currency CHAR(3) NOT NULL,
        original_amount DECIMAL(14,2) NOT NULL,
        installment_count SMALLINT UNSIGNED NOT NULL,
        term_days SMALLINT UNSIGNED NOT NULL,
        due_date DATE NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        canceled_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_credit_accounts_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customer_credit_accounts_sale (tenant_id, sale_id),
        KEY ix_customer_credit_accounts_customer
          (tenant_id, customer_id, due_date),
        CONSTRAINT fk_customer_credit_accounts_customer
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_accounts_sale
          FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_credit_accounts_user
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_accounts_values CHECK (
          original_amount > 0 AND currency REGEXP '^[A-Z]{3}$'
          AND installment_count BETWEEN 1 AND 36
          AND term_days BETWEEN 1 AND 365
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_credit_installments (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        account_id CHAR(36) NOT NULL,
        installment_number SMALLINT UNSIGNED NOT NULL,
        due_date DATE NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_credit_installments_number
          (tenant_id, account_id, installment_number),
        KEY ix_customer_credit_installments_due (tenant_id, due_date),
        CONSTRAINT fk_customer_credit_installments_account
          FOREIGN KEY (account_id, tenant_id)
          REFERENCES customer_credit_accounts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_credit_installments_values CHECK (
          installment_number BETWEEN 1 AND 36 AND amount > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_debt_ledger (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL,
        account_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL,
        entry_type VARCHAR(12) NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        reference_type VARCHAR(16) NOT NULL,
        idempotency_key VARCHAR(180) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_debt_ledger_key (tenant_id, idempotency_key),
        KEY ix_customer_debt_ledger_customer
          (tenant_id, customer_id, created_at),
        KEY ix_customer_debt_ledger_account (tenant_id, account_id, created_at),
        CONSTRAINT fk_customer_debt_ledger_customer
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_debt_ledger_account
          FOREIGN KEY (account_id, tenant_id)
          REFERENCES customer_credit_accounts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_debt_ledger_sale
          FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_debt_ledger_user
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_debt_ledger_values CHECK (
          entry_type IN ('DEBIT', 'CREDIT') AND amount > 0
          AND reference_type IN ('SALE', 'VOID', 'PAYMENT', 'RETURN')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sale_payments
      DROP CHECK ck_sale_payments_reversal_state,
      DROP CHECK ck_sale_payments_status,
      DROP CHECK ck_sale_payments_amounts,
      DROP CHECK ck_sale_payments_authorization_status,
      DROP CHECK ck_sale_payments_method,
      ADD CONSTRAINT ck_sale_payments_method CHECK (
        method IN ('CASH', 'CARD', 'TRANSFER', 'VOUCHER', 'CREDIT')
      ),
      ADD CONSTRAINT ck_sale_payments_authorization_status CHECK (
        authorization_status IN ('APPROVED', 'PENDING')
      ),
      ADD CONSTRAINT ck_sale_payments_amounts CHECK (
        (method = 'CASH' AND authorization_status = 'APPROVED'
          AND amount_received >= amount_applied AND amount_applied > 0
          AND change_amount = amount_received - amount_applied
          AND external_reference IS NULL)
        OR
        (method IN ('CARD', 'TRANSFER', 'VOUCHER')
          AND authorization_status = 'APPROVED'
          AND amount_received = amount_applied AND amount_applied > 0
          AND change_amount = 0 AND external_reference IS NOT NULL
          AND provider_reference IS NOT NULL AND authorization_code IS NOT NULL)
        OR
        (method = 'CREDIT' AND authorization_status = 'PENDING'
          AND amount_received = 0 AND amount_applied > 0 AND change_amount = 0
          AND external_reference IS NULL AND provider = 'CUSTOMER_CREDIT'
          AND provider_reference IS NOT NULL AND authorization_code IS NULL)
      ),
      ADD CONSTRAINT ck_sale_payments_status CHECK (
        status IN ('COMPLETED', 'PENDING', 'REVERSED')
      ),
      ADD CONSTRAINT ck_sale_payments_reversal_state CHECK (
        (status IN ('COMPLETED', 'PENDING')
          AND reversed_by_user_id IS NULL AND reversed_at IS NULL)
        OR (status = 'REVERSED'
          AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_payments
      DROP CHECK ck_sale_payments_reversal_state,
      DROP CHECK ck_sale_payments_status,
      DROP CHECK ck_sale_payments_amounts,
      DROP CHECK ck_sale_payments_authorization_status,
      DROP CHECK ck_sale_payments_method,
      ADD CONSTRAINT ck_sale_payments_method CHECK (
        method IN ('CASH', 'CARD', 'TRANSFER', 'VOUCHER')
      ),
      ADD CONSTRAINT ck_sale_payments_authorization_status CHECK (
        authorization_status = 'APPROVED'
      ),
      ADD CONSTRAINT ck_sale_payments_amounts CHECK (
        (method = 'CASH' AND amount_received >= amount_applied AND amount_applied > 0
          AND change_amount = amount_received - amount_applied AND external_reference IS NULL)
        OR
        (method <> 'CASH' AND amount_received = amount_applied AND amount_applied > 0
          AND change_amount = 0 AND external_reference IS NOT NULL
          AND provider_reference IS NOT NULL AND authorization_code IS NOT NULL)
      ),
      ADD CONSTRAINT ck_sale_payments_status CHECK (
        status IN ('COMPLETED', 'REVERSED')
      ),
      ADD CONSTRAINT ck_sale_payments_reversal_state CHECK (
        (status = 'COMPLETED' AND reversed_by_user_id IS NULL AND reversed_at IS NULL)
        OR (status = 'REVERSED' AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL)
      )
    `);
    await queryRunner.query('DROP TABLE customer_debt_ledger');
    await queryRunner.query('DROP TABLE customer_credit_installments');
    await queryRunner.query('DROP TABLE customer_credit_accounts');
    await queryRunner.query('DROP TABLE customer_credit_profiles');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'SALES_CREDIT'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_DRAWER_OPEN',
        'CASH_REGISTER_OPEN', 'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE',
        'ACCESS_MANAGE', 'AUDIT_VIEW', 'AUDIT_EXPORT', 'PRIVACY_MANAGE',
        'SUPPLIERS_MANAGE', 'PURCHASE_ORDERS_MANAGE',
        'PURCHASE_ORDERS_APPROVE', 'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE'
      ))
    `);
  }
}
