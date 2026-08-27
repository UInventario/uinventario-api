import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePurchaseReceipts1787925600000 implements MigrationInterface {
  name = 'CreatePurchaseReceipts1787925600000';

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
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'PURCHASE_RECEIPTS_OVERAGE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_order_lines
      ADD COLUMN received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER quantity,
      ADD UNIQUE KEY uq_purchase_order_lines_id_tenant (id, tenant_id),
      ADD CONSTRAINT ck_purchase_order_lines_received CHECK (received_quantity >= 0)
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_receipts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        purchase_order_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        document_reference VARCHAR(160) NOT NULL,
        overage_reason VARCHAR(500) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        received_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_receipts_id_tenant (id, tenant_id),
        UNIQUE KEY uq_purchase_receipts_key (tenant_id, idempotency_key),
        KEY ix_purchase_receipts_order (tenant_id, purchase_order_id, created_at, id),
        CONSTRAINT fk_purchase_receipts_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_receipts_order FOREIGN KEY (purchase_order_id, tenant_id)
          REFERENCES purchase_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_receipts_location FOREIGN KEY (location_id, tenant_id)
          REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_receipts_user FOREIGN KEY (received_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_receipt_lines (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        receipt_id CHAR(36) NOT NULL,
        purchase_order_line_id CHAR(36) NOT NULL,
        line_number SMALLINT UNSIGNED NOT NULL,
        received_quantity DECIMAL(15,3) NOT NULL,
        overage_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_receipt_lines_position (tenant_id, receipt_id, line_number),
        UNIQUE KEY uq_purchase_receipt_lines_order_line
          (tenant_id, receipt_id, purchase_order_line_id),
        CONSTRAINT fk_purchase_receipt_lines_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_receipt_lines_receipt FOREIGN KEY (receipt_id, tenant_id)
          REFERENCES purchase_receipts(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_purchase_receipt_lines_order_line
          FOREIGN KEY (purchase_order_line_id, tenant_id)
          REFERENCES purchase_order_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_receipt_lines_values CHECK (
          line_number > 0 AND received_quantity > 0
          AND overage_quantity >= 0 AND overage_quantity <= received_quantity
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE purchase_receipt_lines');
    await queryRunner.query('DROP TABLE purchase_receipts');
    await queryRunner.query(`
      ALTER TABLE purchase_order_lines
      DROP CHECK ck_purchase_order_lines_received,
      DROP KEY uq_purchase_order_lines_id_tenant,
      DROP COLUMN received_quantity
    `);
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'PURCHASE_RECEIPTS_OVERAGE'",
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
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}
