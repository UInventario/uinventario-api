import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryValuationPolicy1787997600000 implements MigrationInterface {
  name = 'AddInventoryValuationPolicy1787997600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE', 'INVENTORY_VALUATION_MANAGE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'INVENTORY_VALUATION_MANAGE'
      FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_valuation_policies (
        tenant_id CHAR(36) NOT NULL,
        method ENUM('MOVING_AVERAGE', 'FIFO', 'SPECIFIC_LOT') NOT NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        effective_at DATETIME(6) NOT NULL,
        migration_rule ENUM('INITIAL_DEFAULT', 'FORWARD_ONLY_CUTOVER') NOT NULL,
        changed_by_user_id CHAR(36) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_inventory_valuation_policies_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_valuation_policies_user_tenant
          FOREIGN KEY (changed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_valuation_policy_history (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        from_method ENUM('MOVING_AVERAGE', 'FIFO', 'SPECIFIC_LOT') NOT NULL,
        to_method ENUM('MOVING_AVERAGE', 'FIFO', 'SPECIFIC_LOT') NOT NULL,
        from_version BIGINT UNSIGNED NOT NULL,
        to_version BIGINT UNSIGNED NOT NULL,
        effective_at DATETIME(6) NOT NULL,
        migration_rule ENUM('FORWARD_ONLY_CUTOVER') NOT NULL,
        plan_fingerprint CHAR(64) NOT NULL,
        migrated_products INT UNSIGNED NOT NULL DEFAULT 0,
        migrated_locations INT UNSIGNED NOT NULL DEFAULT 0,
        changed_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_valuation_history_key
          (tenant_id, idempotency_key),
        KEY ix_inventory_valuation_history_effective
          (tenant_id, effective_at, id),
        CONSTRAINT fk_inventory_valuation_history_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_valuation_history_user_tenant
          FOREIGN KEY (changed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO inventory_valuation_policies
        (tenant_id, method, version, effective_at, migration_rule)
      SELECT id, 'MOVING_AVERAGE', 1, CURRENT_TIMESTAMP(6), 'INITIAL_DEFAULT'
      FROM tenants
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      ADD valuation_method ENUM('MOVING_AVERAGE', 'FIFO', 'SPECIFIC_LOT')
        NOT NULL DEFAULT 'MOVING_AVERAGE' AFTER average_unit_cost,
      ADD valuation_policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1
        AFTER valuation_method,
      ADD valuation_effective_at DATETIME(6) NULL AFTER valuation_policy_version
    `);
    await queryRunner.query(`
      UPDATE inventory_movements im
      INNER JOIN inventory_valuation_policies ivp ON ivp.tenant_id = im.tenant_id
      SET im.valuation_effective_at = ivp.effective_at
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP COLUMN valuation_effective_at,
      DROP COLUMN valuation_policy_version,
      DROP COLUMN valuation_method
    `);
    await queryRunner.query('DROP TABLE inventory_valuation_policy_history');
    await queryRunner.query('DROP TABLE inventory_valuation_policies');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'INVENTORY_VALUATION_MANAGE'",
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
        'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}
