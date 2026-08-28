import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSaleReturns1788022800000 implements MigrationInterface {
  name = 'CreateSaleReturns1788022800000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'SALES_RETURN' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE sale_returns (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL,
        exchange_sale_id CHAR(36) NULL,
        reason VARCHAR(240) NOT NULL,
        settlement_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        subtotal DECIMAL(17,2) NOT NULL,
        tax_total DECIMAL(17,2) NOT NULL,
        total DECIMAL(17,2) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        returned_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_returns_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sale_returns_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_sale_returns_exchange (tenant_id, exchange_sale_id),
        KEY ix_sale_returns_sale (tenant_id, sale_id, created_at, id),
        CONSTRAINT fk_sale_returns_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_returns_sale FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_returns_exchange FOREIGN KEY (exchange_sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_returns_user FOREIGN KEY (returned_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_returns_values CHECK (
          CHAR_LENGTH(reason) >= 3
          AND settlement_status = 'PENDING'
          AND subtotal >= 0 AND tax_total >= 0 AND total >= 0
          AND total = subtotal + tax_total
          AND (exchange_sale_id IS NULL OR exchange_sale_id <> sale_id)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sale_return_lines (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        sale_return_id CHAR(36) NOT NULL,
        sale_line_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        line_number SMALLINT UNSIGNED NOT NULL,
        quantity DECIMAL(18,3) NOT NULL,
        item_condition VARCHAR(20) NOT NULL,
        subtotal DECIMAL(17,2) NOT NULL,
        tax DECIMAL(17,2) NOT NULL,
        total DECIMAL(17,2) NOT NULL,
        serial_numbers JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_return_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sale_return_lines_position
          (tenant_id, sale_return_id, line_number),
        UNIQUE KEY uq_sale_return_lines_sale_line
          (tenant_id, sale_return_id, sale_line_id),
        KEY ix_sale_return_lines_sale_line (tenant_id, sale_line_id),
        CONSTRAINT fk_sale_return_lines_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_lines_return
          FOREIGN KEY (sale_return_id, tenant_id)
          REFERENCES sale_returns(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_return_lines_sale_line
          FOREIGN KEY (sale_line_id, tenant_id)
          REFERENCES sale_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_return_lines_product FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_return_lines_values CHECK (
          line_number > 0 AND quantity > 0
          AND item_condition IN ('SELLABLE', 'DAMAGED')
          AND subtotal >= 0 AND tax >= 0 AND total >= 0
          AND total = subtotal + tax
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_sale_link,
      DROP CHECK ck_inventory_movements_quantity_kind,
      DROP CHECK ck_inventory_movements_type,
      ADD sale_return_id CHAR(36) NULL AFTER sale_line_id,
      ADD sale_return_line_id CHAR(36) NULL AFTER sale_return_id,
      ADD source_sale_movement_id CHAR(36) NULL AFTER sale_return_line_id,
      ADD KEY ix_inventory_movements_sale_return
        (tenant_id, sale_return_id, sale_return_line_id),
      ADD KEY ix_inventory_movements_source_sale
        (tenant_id, source_sale_movement_id),
      ADD CONSTRAINT fk_inventory_movements_sale_return
        FOREIGN KEY (sale_return_id, tenant_id)
        REFERENCES sale_returns(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_sale_return_line
        FOREIGN KEY (sale_return_line_id, tenant_id)
        REFERENCES sale_return_lines(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_source_sale
        FOREIGN KEY (source_sale_movement_id)
        REFERENCES inventory_movements(id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'SALE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT',
          'TRANSFER_DISCREPANCY', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN')
      ),
      ADD CONSTRAINT ck_inventory_movements_quantity_kind CHECK (
        (type IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT') AND quantity_change = 0
          AND state_quantity > 0
          AND from_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND to_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND from_state <> to_state)
        OR
        (type = 'SALE_RETURN' AND quantity_change > 0
          AND from_state IS NULL AND to_state IN ('AVAILABLE', 'DAMAGED')
          AND state_quantity = quantity_change)
        OR
        (type NOT IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT', 'SALE_RETURN')
          AND quantity_change <> 0
          AND from_state IS NULL AND to_state IS NULL AND state_quantity IS NULL)
      ),
      ADD CONSTRAINT ck_inventory_movements_sale_link CHECK (
        (type IN ('SALE', 'SALE_VOID') AND sale_id IS NOT NULL
          AND sale_line_id IS NOT NULL AND sale_return_id IS NULL
          AND sale_return_line_id IS NULL AND source_sale_movement_id IS NULL)
        OR
        (type = 'SALE_RETURN' AND sale_id IS NOT NULL AND sale_line_id IS NOT NULL
          AND sale_return_id IS NOT NULL AND sale_return_line_id IS NOT NULL
          AND source_sale_movement_id IS NOT NULL)
        OR
        (type NOT IN ('SALE', 'SALE_VOID', 'SALE_RETURN') AND sale_id IS NULL
          AND sale_line_id IS NULL AND sale_return_id IS NULL
          AND sale_return_line_id IS NULL AND source_sale_movement_id IS NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [summary] = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM inventory_movements WHERE type = 'SALE_RETURN'",
    )) as Array<{ total: number | string }>;
    if (Number(summary?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert sale returns while movement history exists',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_sale_link,
      DROP CHECK ck_inventory_movements_quantity_kind,
      DROP CHECK ck_inventory_movements_type,
      DROP FOREIGN KEY fk_inventory_movements_source_sale,
      DROP FOREIGN KEY fk_inventory_movements_sale_return_line,
      DROP FOREIGN KEY fk_inventory_movements_sale_return,
      DROP KEY ix_inventory_movements_source_sale,
      DROP KEY ix_inventory_movements_sale_return,
      DROP COLUMN source_sale_movement_id,
      DROP COLUMN sale_return_line_id,
      DROP COLUMN sale_return_id,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT',
          'TRANSFER_DISCREPANCY', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN')
      ),
      ADD CONSTRAINT ck_inventory_movements_quantity_kind CHECK (
        (type IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT') AND quantity_change = 0
          AND state_quantity > 0
          AND from_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND to_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND from_state <> to_state)
        OR
        (type NOT IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT') AND quantity_change <> 0
          AND from_state IS NULL AND to_state IS NULL AND state_quantity IS NULL)
      ),
      ADD CONSTRAINT ck_inventory_movements_sale_link CHECK (
        (type IN ('SALE', 'SALE_VOID') AND sale_id IS NOT NULL AND sale_line_id IS NOT NULL)
        OR (type NOT IN ('SALE', 'SALE_VOID') AND sale_id IS NULL AND sale_line_id IS NULL)
      )
    `);
    await queryRunner.query('DROP TABLE sale_return_lines');
    await queryRunner.query('DROP TABLE sale_returns');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'SALES_RETURN'",
    );
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
  }
}
