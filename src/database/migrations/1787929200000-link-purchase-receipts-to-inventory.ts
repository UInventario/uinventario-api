import { MigrationInterface, QueryRunner } from 'typeorm';

export class LinkPurchaseReceiptsToInventory1787929200000 implements MigrationInterface {
  name = 'LinkPurchaseReceiptsToInventory1787929200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_lines ADD COLUMN unit_cost DECIMAL(15,2) NULL AFTER unit_price
    `);
    await queryRunner.query(`
      UPDATE sale_lines sl
      INNER JOIN products p ON p.id = sl.product_id AND p.tenant_id = sl.tenant_id
      SET sl.unit_cost = p.cost
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      MODIFY unit_cost DECIMAL(15,2) NOT NULL,
      ADD CONSTRAINT ck_sale_lines_unit_cost CHECK (unit_cost >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      ADD COLUMN unit_cost DECIMAL(15,2) NULL AFTER overage_quantity,
      ADD COLUMN total_cost DECIMAL(17,2) NULL AFTER unit_cost,
      ADD COLUMN previous_catalog_cost DECIMAL(15,2) NULL AFTER total_cost,
      ADD COLUMN resulting_catalog_cost DECIMAL(15,2) NULL AFTER previous_catalog_cost
    `);
    await queryRunner.query(`
      UPDATE purchase_receipt_lines prl
      INNER JOIN purchase_order_lines pol
        ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
      INNER JOIN products p ON p.id = pol.product_id AND p.tenant_id = pol.tenant_id
      SET prl.unit_cost = pol.unit_cost,
          prl.total_cost = ROUND(prl.received_quantity * pol.unit_cost, 2),
          prl.previous_catalog_cost = p.cost,
          prl.resulting_catalog_cost = p.cost
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      MODIFY unit_cost DECIMAL(15,2) NOT NULL,
      MODIFY total_cost DECIMAL(17,2) NOT NULL,
      MODIFY previous_catalog_cost DECIMAL(15,2) NOT NULL,
      MODIFY resulting_catalog_cost DECIMAL(15,2) NOT NULL,
      ADD UNIQUE KEY uq_purchase_receipt_lines_id_tenant (id, tenant_id),
      ADD CONSTRAINT ck_purchase_receipt_lines_cost CHECK (
        unit_cost > 0 AND total_cost > 0
        AND previous_catalog_cost >= 0 AND resulting_catalog_cost >= 0
      )
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      MODIFY reference VARCHAR(160) NULL,
      ADD purchase_receipt_id CHAR(36) NULL AFTER inventory_import_row_id,
      ADD purchase_receipt_line_id CHAR(36) NULL AFTER purchase_receipt_id,
      ADD KEY ix_inventory_movements_purchase_receipt
        (tenant_id, purchase_receipt_id, purchase_receipt_line_id),
      ADD CONSTRAINT fk_inventory_movements_purchase_receipt
        FOREIGN KEY (purchase_receipt_id, tenant_id)
        REFERENCES purchase_receipts(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_purchase_receipt_line
        FOREIGN KEY (purchase_receipt_line_id, tenant_id)
        REFERENCES purchase_receipt_lines(id, tenant_id) ON DELETE RESTRICT,
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
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [summary] = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM inventory_movements WHERE type = 'PURCHASE_RECEIPT'",
    )) as Array<{ total: number | string }>;
    if (Number(summary?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert purchase receipt inventory integration while movement history exists',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_purchase_receipt_link,
      DROP CHECK ck_inventory_movements_type,
      DROP FOREIGN KEY fk_inventory_movements_purchase_receipt_line,
      DROP FOREIGN KEY fk_inventory_movements_purchase_receipt,
      DROP KEY ix_inventory_movements_purchase_receipt,
      DROP COLUMN purchase_receipt_line_id,
      DROP COLUMN purchase_receipt_id,
      MODIFY reference VARCHAR(120) NULL,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      DROP CHECK ck_purchase_receipt_lines_cost,
      DROP KEY uq_purchase_receipt_lines_id_tenant,
      DROP COLUMN resulting_catalog_cost,
      DROP COLUMN previous_catalog_cost,
      DROP COLUMN total_cost,
      DROP COLUMN unit_cost
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      DROP CHECK ck_sale_lines_unit_cost,
      DROP COLUMN unit_cost
    `);
  }
}
