import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryLotValuation1787990400000 implements MigrationInterface {
  name = 'AddInventoryLotValuation1787990400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_lots
      ADD unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0 AFTER normalized_code,
      ADD currency CHAR(3) NOT NULL DEFAULT 'USD' AFTER unit_cost,
      ADD CONSTRAINT ck_inventory_lots_cost CHECK (unit_cost >= 0)
    `);
    await queryRunner.query(`
      UPDATE inventory_lots il
      INNER JOIN products p ON p.id = il.product_id AND p.tenant_id = il.tenant_id
      INNER JOIN tenants t ON t.id = il.tenant_id
      SET il.unit_cost = CAST(p.cost AS DECIMAL(15,4)),
          il.currency = CASE t.country_code
            WHEN 'MX' THEN 'MXN'
            WHEN 'CL' THEN 'CLP'
            ELSE 'USD'
          END
    `);
    await queryRunner.query(`
      UPDATE inventory_lots il
      INNER JOIN (
        SELECT tenant_id, lot_id,
               ROUND(SUM(quantity * unit_cost) / SUM(quantity), 4) AS unit_cost,
               MIN(currency) AS currency
        FROM inventory_lot_origins
        GROUP BY tenant_id, lot_id
        HAVING SUM(quantity) > 0 AND COUNT(DISTINCT currency) = 1
      ) origin_cost
        ON origin_cost.tenant_id = il.tenant_id AND origin_cost.lot_id = il.id
      SET il.unit_cost = origin_cost.unit_cost,
          il.currency = origin_cost.currency
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movement_lots
      ADD unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0 AFTER quantity_change,
      ADD currency CHAR(3) NOT NULL DEFAULT 'USD' AFTER unit_cost,
      ADD value_change DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER currency,
      ADD CONSTRAINT ck_inventory_movement_lots_cost CHECK (unit_cost >= 0)
    `);
    await queryRunner.query(`
      UPDATE inventory_movement_lots iml
      INNER JOIN inventory_lots il
        ON il.id = iml.lot_id AND il.tenant_id = iml.tenant_id
      SET iml.unit_cost = il.unit_cost,
          iml.currency = il.currency,
          iml.value_change = ROUND(iml.quantity_change * il.unit_cost, 4)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movement_lots
      DROP CHECK ck_inventory_movement_lots_cost,
      DROP COLUMN value_change,
      DROP COLUMN currency,
      DROP COLUMN unit_cost
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_lots
      DROP CHECK ck_inventory_lots_cost,
      DROP COLUMN currency,
      DROP COLUMN unit_cost
    `);
  }
}
