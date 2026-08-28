import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSupplierReturns1787932800000 implements MigrationInterface {
  name = 'CreateSupplierReturns1787932800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE purchase_returns (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        purchase_order_id CHAR(36) NOT NULL,
        purchase_receipt_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        document_reference VARCHAR(160) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'CREDIT_PENDING',
        expected_credit_total DECIMAL(17,2) NOT NULL,
        credit_document_reference VARCHAR(160) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        returned_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_returns_id_tenant (id, tenant_id),
        UNIQUE KEY uq_purchase_returns_key (tenant_id, idempotency_key),
        KEY ix_purchase_returns_order (tenant_id, purchase_order_id, created_at, id),
        KEY ix_purchase_returns_receipt (tenant_id, purchase_receipt_id, created_at, id),
        CONSTRAINT fk_purchase_returns_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_returns_order FOREIGN KEY (purchase_order_id, tenant_id)
          REFERENCES purchase_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_returns_receipt FOREIGN KEY (purchase_receipt_id, tenant_id)
          REFERENCES purchase_receipts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_returns_location FOREIGN KEY (location_id, tenant_id)
          REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_returns_user FOREIGN KEY (returned_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_returns_values CHECK (
          status IN ('CREDIT_PENDING', 'CREDIT_RECEIVED')
          AND expected_credit_total > 0
          AND CHAR_LENGTH(reason) >= 3
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_return_lines (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        purchase_return_id CHAR(36) NOT NULL,
        purchase_receipt_line_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        line_number SMALLINT UNSIGNED NOT NULL,
        returned_quantity DECIMAL(15,3) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        total_cost DECIMAL(17,2) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_return_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_purchase_return_lines_position
          (tenant_id, purchase_return_id, line_number),
        UNIQUE KEY uq_purchase_return_lines_receipt_line
          (tenant_id, purchase_return_id, purchase_receipt_line_id),
        KEY ix_purchase_return_lines_receipt_line
          (tenant_id, purchase_receipt_line_id),
        CONSTRAINT fk_purchase_return_lines_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_return_lines_return
          FOREIGN KEY (purchase_return_id, tenant_id)
          REFERENCES purchase_returns(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_purchase_return_lines_receipt_line
          FOREIGN KEY (purchase_receipt_line_id, tenant_id)
          REFERENCES purchase_receipt_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_return_lines_product FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_return_lines_values CHECK (
          line_number > 0 AND returned_quantity > 0
          AND unit_cost > 0 AND total_cost > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_purchase_receipt_link,
      DROP CHECK ck_inventory_movements_type,
      ADD purchase_return_id CHAR(36) NULL AFTER purchase_receipt_line_id,
      ADD purchase_return_line_id CHAR(36) NULL AFTER purchase_return_id,
      ADD KEY ix_inventory_movements_purchase_return
        (tenant_id, purchase_return_id, purchase_return_line_id),
      ADD CONSTRAINT fk_inventory_movements_purchase_return
        FOREIGN KEY (purchase_return_id, tenant_id)
        REFERENCES purchase_returns(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_purchase_return_line
        FOREIGN KEY (purchase_return_line_id, tenant_id)
        REFERENCES purchase_return_lines(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT',
          'TRANSFER_DISCREPANCY', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN')
      ),
      ADD CONSTRAINT ck_inventory_movements_purchase_document_link CHECK (
        (type = 'PURCHASE_RECEIPT' AND purchase_receipt_id IS NOT NULL
          AND purchase_receipt_line_id IS NOT NULL
          AND purchase_return_id IS NULL AND purchase_return_line_id IS NULL)
        OR
        (type = 'SUPPLIER_RETURN' AND purchase_receipt_id IS NULL
          AND purchase_receipt_line_id IS NULL
          AND purchase_return_id IS NOT NULL AND purchase_return_line_id IS NOT NULL)
        OR
        (type NOT IN ('PURCHASE_RECEIPT', 'SUPPLIER_RETURN')
          AND purchase_receipt_id IS NULL AND purchase_receipt_line_id IS NULL
          AND purchase_return_id IS NULL AND purchase_return_line_id IS NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [summary] = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM inventory_movements WHERE type = 'SUPPLIER_RETURN'",
    )) as Array<{ total: number | string }>;
    if (Number(summary?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert supplier returns while movement history exists',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_purchase_document_link,
      DROP CHECK ck_inventory_movements_type,
      DROP FOREIGN KEY fk_inventory_movements_purchase_return_line,
      DROP FOREIGN KEY fk_inventory_movements_purchase_return,
      DROP KEY ix_inventory_movements_purchase_return,
      DROP COLUMN purchase_return_line_id,
      DROP COLUMN purchase_return_id,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT',
          'TRANSFER_DISCREPANCY', 'PURCHASE_RECEIPT')
      ),
      ADD CONSTRAINT ck_inventory_movements_purchase_receipt_link CHECK (
        (type = 'PURCHASE_RECEIPT' AND purchase_receipt_id IS NOT NULL
          AND purchase_receipt_line_id IS NOT NULL)
        OR
        (type <> 'PURCHASE_RECEIPT' AND purchase_receipt_id IS NULL
          AND purchase_receipt_line_id IS NULL)
      )
    `);
    await queryRunner.query('DROP TABLE purchase_return_lines');
    await queryRunner.query('DROP TABLE purchase_returns');
  }
}
