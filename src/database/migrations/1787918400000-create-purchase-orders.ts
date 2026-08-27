import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePurchaseOrders1787918400000 implements MigrationInterface {
  name = 'CreatePurchaseOrders1787918400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'PURCHASE_ORDERS_MANAGE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_order_sequences (
        tenant_id CHAR(36) NOT NULL,
        next_number BIGINT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_purchase_order_sequences_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_order_sequences_number CHECK (next_number > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_orders (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        folio VARCHAR(32) NOT NULL,
        supplier_id CHAR(36) NOT NULL,
        currency CHAR(3) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
        notes VARCHAR(1000) NULL,
        subtotal DECIMAL(17,2) NOT NULL,
        total DECIMAL(17,2) NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_orders_id_tenant (id, tenant_id),
        UNIQUE KEY uq_purchase_orders_folio (tenant_id, folio),
        KEY ix_purchase_orders_supplier_status (tenant_id, supplier_id, status, updated_at),
        CONSTRAINT fk_purchase_orders_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_orders_supplier FOREIGN KEY (supplier_id, tenant_id)
          REFERENCES suppliers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_orders_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_orders_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
        CONSTRAINT ck_purchase_orders_status CHECK (status IN (
          'DRAFT', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'
        )),
        CONSTRAINT ck_purchase_orders_totals CHECK (subtotal >= 0 AND total >= 0),
        CONSTRAINT ck_purchase_orders_version CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_order_lines (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        purchase_order_id CHAR(36) NOT NULL,
        supplier_product_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        position SMALLINT UNSIGNED NOT NULL,
        supplier_code VARCHAR(64) NOT NULL,
        product_name VARCHAR(180) NOT NULL,
        product_sku VARCHAR(40) NOT NULL,
        quantity DECIMAL(15,3) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        subtotal DECIMAL(17,2) NOT NULL,
        notes VARCHAR(500) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_order_lines_position (tenant_id, purchase_order_id, position),
        UNIQUE KEY uq_purchase_order_lines_product (tenant_id, purchase_order_id, supplier_product_id),
        CONSTRAINT fk_purchase_order_lines_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_order_lines_order FOREIGN KEY (purchase_order_id, tenant_id)
          REFERENCES purchase_orders(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_purchase_order_lines_supplier_product
          FOREIGN KEY (supplier_product_id, tenant_id)
          REFERENCES supplier_products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_order_lines_product FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_order_lines_values CHECK (
          position > 0 AND quantity > 0 AND unit_cost > 0 AND subtotal > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE purchase_order_lines');
    await queryRunner.query('DROP TABLE purchase_orders');
    await queryRunner.query('DROP TABLE purchase_order_sequences');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'PURCHASE_ORDERS_MANAGE'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}
