import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUncodedProductsAndSaleLineControls1788094800000 implements MigrationInterface {
  name = 'AddUncodedProductsAndSaleLineControls1788094800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN code_mode VARCHAR(12) NOT NULL DEFAULT 'EXPLICIT' AFTER barcode,
      ADD COLUMN stock_behavior VARCHAR(12) NOT NULL DEFAULT 'TRACKED' AFTER code_mode,
      ADD COLUMN tax_behavior VARCHAR(12) NOT NULL DEFAULT 'STANDARD' AFTER stock_behavior,
      ADD CONSTRAINT ck_products_sale_behavior CHECK (
        code_mode IN ('EXPLICIT', 'GENERATED')
        AND stock_behavior IN ('TRACKED', 'UNTRACKED')
        AND tax_behavior IN ('STANDARD', 'EXEMPT')
        AND (stock_behavior = 'TRACKED' OR (track_lots = FALSE AND track_serials = FALSE))
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      DROP CHECK ck_sale_lines_price_source,
      ADD COLUMN without_code BOOLEAN NOT NULL DEFAULT FALSE AFTER product_sku,
      ADD COLUMN line_note VARCHAR(240) NULL AFTER quantity,
      ADD COLUMN price_override_reason VARCHAR(240) NULL AFTER price_source,
      ADD COLUMN stock_behavior VARCHAR(12) NOT NULL DEFAULT 'TRACKED' AFTER price_override_reason,
      ADD COLUMN tax_behavior VARCHAR(12) NOT NULL DEFAULT 'STANDARD' AFTER stock_behavior,
      ADD CONSTRAINT ck_sale_lines_price_source CHECK (
        (price_source = 'BASE' AND price_list_id IS NULL AND price_list_name IS NULL
          AND price_override_reason IS NULL)
        OR (price_source = 'PRICE_LIST' AND price_list_id IS NOT NULL
          AND price_list_name IS NOT NULL AND price_override_reason IS NULL)
        OR (price_source = 'MANUAL' AND price_list_id IS NULL
          AND price_list_name IS NULL AND price_override_reason IS NOT NULL)
      ),
      ADD CONSTRAINT ck_sale_lines_behavior CHECK (
        stock_behavior IN ('TRACKED', 'UNTRACKED')
        AND tax_behavior IN ('STANDARD', 'EXEMPT')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALES_PRICE_OVERRIDE', 'SALES_CREDIT',
        'SALE_REPRINT', 'CASH_DRAWER_OPEN', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'PURCHASE_RECEIPTS_OVERAGE', 'INVENTORY_VIEW', 'INVENTORY_ADJUST',
        'INVENTORY_TRANSFER', 'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE', 'INVENTORY_EXPIRED_STOCK_OVERRIDE',
        'NOTIFICATIONS_VIEW', 'NOTIFICATIONS_MANAGE'
      ))
    `);
    await queryRunner.query(`
      ALTER TABLE sales_quotation_lines
      DROP CHECK ck_sales_quotation_lines_price_source,
      ADD COLUMN without_code BOOLEAN NOT NULL DEFAULT FALSE AFTER product_sku,
      ADD COLUMN line_note VARCHAR(240) NULL AFTER quantity,
      ADD COLUMN price_override_reason VARCHAR(240) NULL AFTER price_source,
      ADD COLUMN stock_behavior VARCHAR(12) NOT NULL DEFAULT 'TRACKED' AFTER price_override_reason,
      ADD COLUMN tax_behavior VARCHAR(12) NOT NULL DEFAULT 'STANDARD' AFTER stock_behavior,
      ADD CONSTRAINT ck_sales_quotation_lines_price_source CHECK (
        (price_source = 'BASE' AND price_list_id IS NULL AND price_list_name IS NULL
          AND price_override_reason IS NULL)
        OR (price_source = 'PRICE_LIST' AND price_list_id IS NOT NULL
          AND price_list_name IS NOT NULL AND price_override_reason IS NULL)
        OR (price_source = 'MANUAL' AND price_list_id IS NULL
          AND price_list_name IS NULL AND price_override_reason IS NOT NULL)
      ),
      ADD CONSTRAINT ck_sales_quotation_lines_behavior CHECK (
        stock_behavior IN ('TRACKED', 'UNTRACKED')
        AND tax_behavior IN ('STANDARD', 'EXEMPT')
      )
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'SALES_PRICE_OVERRIDE' FROM roles WHERE code = 'ADMIN'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'SALES_PRICE_OVERRIDE'",
    );
    await queryRunner.query(`
      UPDATE sales_quotation_lines
      SET price_source = 'BASE', price_list_id = NULL, price_list_name = NULL,
          price_override_reason = NULL
      WHERE price_source = 'MANUAL'
    `);
    await queryRunner.query(`
      ALTER TABLE sales_quotation_lines
      DROP CHECK ck_sales_quotation_lines_behavior,
      DROP CHECK ck_sales_quotation_lines_price_source,
      ADD CONSTRAINT ck_sales_quotation_lines_price_source CHECK (
        price_source IN ('BASE', 'PRICE_LIST')
      ),
      DROP COLUMN tax_behavior,
      DROP COLUMN stock_behavior,
      DROP COLUMN price_override_reason,
      DROP COLUMN line_note,
      DROP COLUMN without_code
    `);
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
        'INVENTORY_COUNT', 'INVENTORY_APPROVE', 'INVENTORY_VALUATION_MANAGE',
        'INVENTORY_EXPIRED_STOCK_OVERRIDE', 'NOTIFICATIONS_VIEW',
        'NOTIFICATIONS_MANAGE'
      ))
    `);
    await queryRunner.query(`
      UPDATE sale_lines
      SET price_source = 'BASE', price_list_id = NULL, price_list_name = NULL,
          price_override_reason = NULL
      WHERE price_source = 'MANUAL'
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      DROP CHECK ck_sale_lines_behavior,
      DROP CHECK ck_sale_lines_price_source,
      ADD CONSTRAINT ck_sale_lines_price_source CHECK (
        (price_source = 'BASE' AND price_list_id IS NULL AND price_list_name IS NULL)
        OR (price_source = 'PRICE_LIST' AND price_list_id IS NOT NULL
          AND price_list_name IS NOT NULL)
      ),
      DROP COLUMN tax_behavior,
      DROP COLUMN stock_behavior,
      DROP COLUMN price_override_reason,
      DROP COLUMN line_note,
      DROP COLUMN without_code
    `);
    await queryRunner.query(`
      ALTER TABLE products
      DROP CHECK ck_products_sale_behavior,
      DROP COLUMN tax_behavior,
      DROP COLUMN stock_behavior,
      DROP COLUMN code_mode
    `);
  }
}
