import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePosPeripheralProfiles1788033600000 implements MigrationInterface {
  name = 'CreatePosPeripheralProfiles1788033600000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'CASH_DRAWER_OPEN' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE pos_peripheral_profiles (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL,
        device_id VARCHAR(80) NOT NULL,
        label VARCHAR(120) NOT NULL,
        adapter VARCHAR(20) NOT NULL DEFAULT 'SIMULATOR',
        printer_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        drawer_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        auto_open_cash_sale BOOLEAN NOT NULL DEFAULT TRUE,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_pos_peripheral_profiles_id_tenant (id, tenant_id),
        UNIQUE KEY uq_pos_peripheral_profiles_register (tenant_id, cash_register_id),
        UNIQUE KEY uq_pos_peripheral_profiles_device (tenant_id, device_id),
        CONSTRAINT fk_pos_peripheral_profiles_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_pos_peripheral_profiles_register
          FOREIGN KEY (cash_register_id, tenant_id)
          REFERENCES cash_registers(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_pos_peripheral_profiles_values CHECK (
          adapter IN ('SIMULATOR')
          AND CHAR_LENGTH(device_id) BETWEEN 3 AND 80
          AND CHAR_LENGTH(label) BETWEEN 2 AND 120
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE pos_peripheral_operations (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL,
        profile_id CHAR(36) NOT NULL,
        device_id VARCHAR(80) NOT NULL,
        sale_id CHAR(36) NULL,
        action VARCHAR(24) NOT NULL,
        trigger_event VARCHAR(32) NOT NULL,
        status VARCHAR(20) NOT NULL,
        attempt_count INT UNSIGNED NOT NULL DEFAULT 1,
        error_code VARCHAR(80) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        requested_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pos_peripheral_operations_key (tenant_id, idempotency_key),
        KEY ix_pos_peripheral_operations_register
          (tenant_id, cash_register_id, created_at),
        KEY ix_pos_peripheral_operations_sale (tenant_id, sale_id, action),
        CONSTRAINT fk_pos_peripheral_operations_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_pos_peripheral_operations_register
          FOREIGN KEY (cash_register_id, tenant_id)
          REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_pos_peripheral_operations_profile
          FOREIGN KEY (profile_id, tenant_id)
          REFERENCES pos_peripheral_profiles(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_pos_peripheral_operations_sale
          FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_pos_peripheral_operations_user
          FOREIGN KEY (requested_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_pos_peripheral_operations_values CHECK (
          action IN ('PRINT_RECEIPT', 'OPEN_DRAWER')
          AND trigger_event IN ('MANUAL', 'CASH_SALE_COMPLETED')
          AND status IN ('COMPLETED', 'FAILED')
          AND attempt_count > 0
          AND CHAR_LENGTH(device_id) BETWEEN 3 AND 80
          AND ((status = 'COMPLETED' AND error_code IS NULL
            AND completed_at IS NOT NULL)
            OR (status = 'FAILED' AND error_code IS NOT NULL))
          AND (action <> 'PRINT_RECEIPT' OR sale_id IS NOT NULL)
          AND (trigger_event <> 'CASH_SALE_COMPLETED' OR sale_id IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE pos_peripheral_operations');
    await queryRunner.query('DROP TABLE pos_peripheral_profiles');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'CASH_DRAWER_OPEN'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'PURCHASE_RECEIPTS_OVERAGE', 'INVENTORY_VIEW', 'INVENTORY_ADJUST',
        'INVENTORY_TRANSFER', 'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE'
      ))
    `);
  }
}
