import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMovingAverageValuation1787983200000 implements MigrationInterface {
  name = 'AddMovingAverageValuation1787983200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_valuations (
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
        inventory_value DECIMAL(21,4) NOT NULL DEFAULT 0,
        average_unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, product_id),
        CONSTRAINT fk_inventory_valuations_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_valuations_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE CASCADE,
        CONSTRAINT ck_inventory_valuations_quantity CHECK (quantity >= 0),
        CONSTRAINT ck_inventory_valuations_value CHECK (inventory_value >= 0),
        CONSTRAINT ck_inventory_valuations_cost CHECK (average_unit_cost >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO inventory_valuations
        (tenant_id, product_id, quantity, inventory_value, average_unit_cost)
      SELECT p.tenant_id, p.id, COALESCE(SUM(ib.quantity), 0),
             ROUND(COALESCE(SUM(ib.quantity), 0) * p.cost, 4),
             CAST(p.cost AS DECIMAL(15,4))
      FROM products p
      LEFT JOIN inventory_balances ib
        ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
      GROUP BY p.tenant_id, p.id, p.cost
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      ADD unit_cost DECIMAL(15,4) NULL AFTER quantity_change,
      ADD value_change DECIMAL(21,4) NULL AFTER unit_cost,
      ADD resulting_inventory_value DECIMAL(21,4) NULL AFTER value_change,
      ADD average_unit_cost DECIMAL(15,4) NULL AFTER resulting_inventory_value
    `);
    await queryRunner.query(`
      UPDATE inventory_movements im
      INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
      LEFT JOIN purchase_receipt_lines prl
        ON prl.id = im.purchase_receipt_line_id AND prl.tenant_id = im.tenant_id
      LEFT JOIN sale_lines sl
        ON sl.id = im.sale_line_id AND sl.tenant_id = im.tenant_id
      SET im.unit_cost = CASE
            WHEN im.type = 'PURCHASE_RECEIPT' THEN COALESCE(prl.unit_cost, p.cost)
            WHEN im.type IN ('SALE', 'SALE_VOID') THEN COALESCE(sl.unit_cost, p.cost)
            ELSE p.cost
          END,
          im.value_change = ROUND(im.quantity_change * CASE
            WHEN im.type = 'PURCHASE_RECEIPT' THEN COALESCE(prl.unit_cost, p.cost)
            WHEN im.type IN ('SALE', 'SALE_VOID') THEN COALESCE(sl.unit_cost, p.cost)
            ELSE p.cost
          END, 4)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP COLUMN average_unit_cost,
      DROP COLUMN resulting_inventory_value,
      DROP COLUMN value_change,
      DROP COLUMN unit_cost
    `);
    await queryRunner.query('DROP TABLE inventory_valuations');
  }
}
