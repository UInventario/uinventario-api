import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryLotExpiration1788066000000 implements MigrationInterface {
  name = 'AddInventoryLotExpiration1788066000000';

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
        'INVENTORY_VALUATION_MANAGE', 'INVENTORY_EXPIRED_STOCK_OVERRIDE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'INVENTORY_EXPIRED_STOCK_OVERRIDE'
      FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE products
      ADD lot_expiration_policy ENUM('NONE', 'OPTIONAL', 'REQUIRED')
        NOT NULL DEFAULT 'NONE' AFTER track_lots,
      ADD lot_expiration_alert_days SMALLINT UNSIGNED NOT NULL DEFAULT 30
        AFTER lot_expiration_policy,
      ADD allow_expired_stock_override BOOLEAN NOT NULL DEFAULT FALSE
        AFTER lot_expiration_alert_days,
      ADD CONSTRAINT ck_products_lot_expiration_alert_days
        CHECK (lot_expiration_alert_days BETWEEN 1 AND 365),
      ADD CONSTRAINT ck_products_lot_expiration_tracking CHECK (
        lot_expiration_policy = 'NONE' OR track_lots = TRUE
      )
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_lots
      ADD manufactured_on DATE NULL AFTER normalized_code,
      ADD expires_on DATE NULL AFTER manufactured_on,
      ADD KEY ix_inventory_lots_expiration
        (tenant_id, product_id, expires_on, created_at, id),
      ADD CONSTRAINT ck_inventory_lots_date_range CHECK (
        manufactured_on IS NULL OR expires_on IS NULL OR manufactured_on <= expires_on
      )
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      ADD manufactured_on DATE NULL AFTER lot_id,
      ADD expires_on DATE NULL AFTER manufactured_on,
      ADD CONSTRAINT ck_purchase_receipt_lines_date_range CHECK (
        manufactured_on IS NULL OR expires_on IS NULL OR manufactured_on <= expires_on
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      ADD expired_lot_override_reason VARCHAR(240) NULL AFTER discount_reason
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sale_lines DROP COLUMN expired_lot_override_reason',
    );
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      DROP CHECK ck_purchase_receipt_lines_date_range,
      DROP COLUMN expires_on,
      DROP COLUMN manufactured_on
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_lots
      DROP CHECK ck_inventory_lots_date_range,
      DROP INDEX ix_inventory_lots_expiration,
      DROP COLUMN expires_on,
      DROP COLUMN manufactured_on
    `);
    await queryRunner.query(`
      ALTER TABLE products
      DROP CHECK ck_products_lot_expiration_tracking,
      DROP CHECK ck_products_lot_expiration_alert_days,
      DROP COLUMN allow_expired_stock_override,
      DROP COLUMN lot_expiration_alert_days,
      DROP COLUMN lot_expiration_policy
    `);
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'INVENTORY_EXPIRED_STOCK_OVERRIDE'",
    );
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
  }
}
