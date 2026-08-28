import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCustomerPrivacyControls1788012000000 implements MigrationInterface {
  name = 'AddCustomerPrivacyControls1788012000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'PURCHASE_RECEIPTS_OVERAGE', 'INVENTORY_VIEW', 'INVENTORY_ADJUST',
        'INVENTORY_TRANSFER', 'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'PRIVACY_MANAGE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE customers
      ADD privacy_status ENUM('ACTIVE', 'ANONYMIZED') NOT NULL DEFAULT 'ACTIVE'
        AFTER data_processing_consent,
      ADD anonymized_at DATETIME(6) NULL AFTER privacy_status,
      ADD privacy_retention_until DATETIME(6) NULL AFTER anonymized_at,
      ADD KEY ix_customers_privacy (tenant_id, privacy_status, anonymized_at)
    `);
    await queryRunner.query(`
      CREATE TABLE privacy_policies (
        tenant_id CHAR(36) NOT NULL,
        country_code VARCHAR(16) NOT NULL,
        minimum_transaction_retention_days INT UNSIGNED NOT NULL,
        transaction_retention_days INT UNSIGNED NOT NULL,
        policy_code VARCHAR(64) NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        changed_by_user_id CHAR(36) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_privacy_policies_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_privacy_policies_user_tenant
          FOREIGN KEY (changed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_privacy_policy_retention CHECK (
          transaction_retention_days >= minimum_transaction_retention_days
          AND minimum_transaction_retention_days >= 365
        ),
        CONSTRAINT ck_privacy_policy_version CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO privacy_policies
        (tenant_id, country_code, minimum_transaction_retention_days,
         transaction_retention_days, policy_code)
      SELECT id, COALESCE(country_code, 'DEFAULT'),
             CASE WHEN country_code = 'MX' THEN 1825 ELSE 365 END,
             CASE WHEN country_code = 'MX' THEN 1825 ELSE 365 END,
             CASE WHEN country_code = 'MX' THEN 'MX_CFF_ARTICLE_30'
                  ELSE 'DEFAULT_CONSERVATIVE' END
      FROM tenants
    `);
    await queryRunner.query(`
      CREATE TABLE privacy_legal_holds (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        active_customer_id CHAR(36)
          GENERATED ALWAYS AS (CASE WHEN active THEN customer_id ELSE NULL END) STORED,
        reason VARCHAR(240) NOT NULL,
        expires_at DATETIME(6) NULL,
        created_by_user_id CHAR(36) NOT NULL,
        released_by_user_id CHAR(36) NULL,
        released_at DATETIME(6) NULL,
        release_reason VARCHAR(240) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_privacy_active_hold (tenant_id, active_customer_id),
        KEY ix_privacy_holds_customer (tenant_id, customer_id, created_at),
        CONSTRAINT fk_privacy_holds_customer_tenant
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_privacy_holds_created_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_privacy_holds_released_user_tenant
          FOREIGN KEY (released_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE privacy_requests (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NULL,
        request_type ENUM(
          'ACCESS_EXPORT', 'ANONYMIZATION', 'LEGAL_HOLD',
          'LEGAL_HOLD_RELEASE', 'POLICY_CHANGE'
        ) NOT NULL,
        status ENUM('COMPLETED', 'BLOCKED') NOT NULL,
        idempotency_key VARCHAR(128) NULL,
        request_fingerprint CHAR(64) NULL,
        request_reference VARCHAR(120) NULL,
        decision_code VARCHAR(64) NOT NULL,
        policy_version INT UNSIGNED NOT NULL,
        retention_until DATETIME(6) NULL,
        result_json JSON NULL,
        actor_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_privacy_request_key (tenant_id, idempotency_key),
        KEY ix_privacy_requests_customer (tenant_id, customer_id, created_at),
        CONSTRAINT fk_privacy_requests_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_privacy_requests_customer_tenant
          FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_privacy_requests_actor_tenant
          FOREIGN KEY (actor_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE privacy_requests');
    await queryRunner.query('DROP TABLE privacy_legal_holds');
    await queryRunner.query('DROP TABLE privacy_policies');
    await queryRunner.query(`
      ALTER TABLE customers DROP KEY ix_customers_privacy,
      DROP COLUMN privacy_retention_until,
      DROP COLUMN anonymized_at,
      DROP COLUMN privacy_status
    `);
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'PRIVACY_MANAGE'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'PURCHASE_RECEIPTS_OVERAGE', 'INVENTORY_VIEW', 'INVENTORY_ADJUST',
        'INVENTORY_TRANSFER', 'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE'
      ))
    `);
  }
}
